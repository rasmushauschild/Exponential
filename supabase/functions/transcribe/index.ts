// Supabase Edge Function: the app's shared transcription proxy.
// The AssemblyAI key lives ONLY here (function secret ASSEMBLYAI_KEY) — never in the
// shipped binary. Callers must be signed-in members with access to the meeting; the
// function then points AssemblyAI at a short-lived signed URL of the stored audio, so
// no audio bytes flow through the function itself.
//
// Deploy: dashboard → Edge Functions → New function "transcribe" → paste this → Deploy
// Secret: Edge Functions → Secrets → ASSEMBLYAI_KEY = <key from assemblyai.com>

import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const KEY = Deno.env.get("ASSEMBLYAI_KEY");
    if (!KEY) return json({ error: "ASSEMBLYAI_KEY is not configured" }, 500);

    const authHeader = req.headers.get("Authorization") ?? "";
    const anon = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await anon.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);

    const body = await req.json();

    if (body.action === "start") {
      const svc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const { data: m } = await svc.from("meetings")
        .select("id, team_id, owner, is_open, access, audio_path")
        .eq("id", String(body.meetingId)).single();
      if (!m?.audio_path) return json({ error: "meeting has no stored audio" }, 404);
      const { data: member } = await svc.from("team_members")
        .select("user_id").eq("team_id", m.team_id).eq("user_id", user.id).maybeSingle();
      const allowed = !!member && (m.is_open || m.owner === user.id || (m.access ?? []).includes(user.id));
      if (!allowed) return json({ error: "forbidden" }, 403);
      const { data: signed, error: sErr } = await svc.storage.from("meetings").createSignedUrl(m.audio_path, 7200);
      if (sErr || !signed) return json({ error: "could not sign audio url" }, 500);
      const r = await fetch("https://api.assemblyai.com/v2/transcript", {
        method: "POST",
        headers: { authorization: KEY, "content-type": "application/json" },
        body: JSON.stringify({ audio_url: signed.signedUrl, speaker_labels: true, language_detection: true }),
      });
      return new Response(await r.text(), { status: r.status, headers: { ...CORS, "content-type": "application/json" } });
    }

    if (body.action === "poll") {
      const id = String(body.id ?? "");
      if (!/^[\w-]+$/.test(id)) return json({ error: "bad id" }, 400);
      const r = await fetch(`https://api.assemblyai.com/v2/transcript/${id}`, { headers: { authorization: KEY } });
      return new Response(await r.text(), { status: r.status, headers: { ...CORS, "content-type": "application/json" } });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
