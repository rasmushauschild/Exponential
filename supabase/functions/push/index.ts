// Supabase Edge Function: fans a new chat message out as Web Push to team phones.
// Wire it to a DATABASE WEBHOOK: Database → Webhooks → new hook on public.messages,
// INSERT only → HTTP request → this function's URL, and add the header
// `x-push-secret: <PUSH_WEBHOOK_SECRET>` if you set that secret.
//
// Deploy: dashboard → Edge Functions → New function "push" → paste this → Deploy.
// Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:you@…),
//          optionally PUSH_WEBHOOK_SECRET.
// The function re-reads everything by id with the service role, so a spoofed call can
// only ever push a message that genuinely exists in the database.

import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const MENTION_RE = /@\[([\w-]{1,40})\]/g;

Deno.serve(async (req) => {
  try {
    const secret = Deno.env.get("PUSH_WEBHOOK_SECRET");
    if (secret && req.headers.get("x-push-secret") !== secret) return new Response("forbidden", { status: 403 });

    const pub = Deno.env.get("VAPID_PUBLIC_KEY");
    const priv = Deno.env.get("VAPID_PRIVATE_KEY");
    if (!pub || !priv) return new Response("VAPID keys not configured", { status: 500 });
    webpush.setVapidDetails(Deno.env.get("VAPID_SUBJECT") ?? "mailto:r.hauschild@airyautomotive.com", pub, priv);

    const body = await req.json();
    const id = body?.record?.id;
    if (!id) return new Response("no record", { status: 400 });

    const svc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: m } = await svc.from("messages")
      .select("id, channel_id, team_id, author, body, attachments, deleted_at, created_at")
      .eq("id", id).single();
    if (!m || m.deleted_at) return new Response("gone", { status: 200 });
    // only fresh messages ring phones — imports/backfills with old timestamps stay silent
    if (Date.now() - +new Date(m.created_at) > 5 * 60_000) return new Response("stale", { status: 200 });

    const { data: ch } = await svc.from("channels").select("id, name, is_private").eq("id", m.channel_id).single();
    if (!ch) return new Response("no channel", { status: 200 });

    // recipients: channel members for private channels/DMs, whole team otherwise — never the author
    let recipients: string[];
    if (ch.is_private) {
      const { data } = await svc.from("channel_members").select("user_id").eq("channel_id", ch.id);
      recipients = (data ?? []).map((r) => r.user_id);
    } else {
      const { data } = await svc.from("team_members").select("user_id").eq("team_id", m.team_id).not("user_id", "is", null);
      recipients = (data ?? []).map((r) => r.user_id as string);
    }
    recipients = [...new Set(recipients)].filter((u) => u !== m.author);
    if (!recipients.length) return new Response("no recipients", { status: 200 });

    const { data: profs } = await svc.from("profiles").select("id, name").in("id", [...recipients, ...(m.author ? [m.author] : [])]);
    const nameOf = (uid: string) => (profs ?? []).find((p) => p.id === uid)?.name?.split(" ")[0] || "Someone";
    const authorName = m.author ? nameOf(m.author) : "Someone";

    const mentioned = new Set([...String(m.body ?? "").matchAll(MENTION_RE)].map((x) => x[1]));
    let text = String(m.body ?? "").replace(MENTION_RE, (_, uid) => `@${nameOf(uid)}`);
    if (!text && Array.isArray(m.attachments) && m.attachments.length) {
      const a = m.attachments[0];
      text = a.type?.startsWith("image/") ? "📷 Image" : `📎 ${a.name ?? "File"}`;
    }
    if (!text) return new Response("empty", { status: 200 });
    if (text.length > 140) text = `${text.slice(0, 140)}…`;

    const isDm = ch.name.startsWith("dm:");
    const { data: subs } = await svc.from("push_subscriptions").select("endpoint, p256dh, auth, user_id").in("user_id", recipients);
    let sent = 0, pruned = 0;
    await Promise.all((subs ?? []).map(async (s) => {
      const title = mentioned.has(s.user_id) ? `${authorName} mentioned you${isDm ? "" : ` in #${ch.name}`}` : isDm ? authorName : `#${ch.name} · ${authorName}`;
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify({ title, body: text, channelId: ch.id }),
        );
        sent++;
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) { await svc.from("push_subscriptions").delete().eq("endpoint", s.endpoint); pruned++; }
      }
    }));
    return new Response(JSON.stringify({ sent, pruned }), { status: 200, headers: { "content-type": "application/json" } });
  } catch (e) {
    return new Response(String((e as Error).message ?? e), { status: 500 });
  }
});
