import { supabase } from './cloud';
import { uid } from './store';

/**
 * Slack-style chat. Deliberately OUTSIDE the Data blob: messages load lazily per channel
 * and arrive over realtime row events (never a whole-team refetch), so chatting is cheap
 * on egress and never touches plan undo history. Cloud rows live in channels /
 * channel_members / messages (RLS: team members; private channels gate on membership),
 * files in the private 'chat' storage bucket. The browser preview (and pre-sign-in) runs
 * the same API against localStorage so the UI works without a backend.
 */

export interface Attachment { path: string; name: string; size: number; type: string; w?: number; h?: number }
export interface ChatMessage {
  id: string; channelId: string; author?: string; body: string;
  attachments?: Attachment[]; reactions?: Record<string, string[]>; // emoji → user ids
  editedAt?: string; deletedAt?: string; at: string; pending?: boolean;
}
export interface Channel {
  id: string; name: string; topic?: string; private: boolean; createdBy?: string;
  members?: string[]; // private channels only
  lastRead?: string; unread: number; lastAt?: string;
}

/* ── shared event bus: realtime (cloud) and local ops both land here ── */

export type ChatEvent =
  | { type: 'message'; teamId: string; message: ChatMessage }
  | { type: 'message-changed'; teamId: string; message: ChatMessage }
  | { type: 'channels'; teamId: string };

const listeners = new Set<(e: ChatEvent) => void>();
export function onChatEvent(cb: (e: ChatEvent) => void) { listeners.add(cb); return () => { listeners.delete(cb); }; }
const emit = (e: ChatEvent) => listeners.forEach((cb) => cb(e));

/* ── module-level caches: the panel unmounts when closed, but App's realtime
   subscription keeps running — these stay warm, so reopening renders instantly
   and already includes everything that arrived meanwhile. ── */

export const messageCache = new Map<string, ChatMessage[]>(); // channelId → latest page + live tail
const previewCache = new Map<string, Record<string, { body: string; author?: string; at: string }>>();
export const cachedPreviews = (teamId: string) => previewCache.get(teamId);

const digestMsg = (m: ChatMessage) => ({ body: m.body || (m.attachments?.length ? (m.attachments[0].type.startsWith('image/') ? '📷 Image' : m.attachments[0].name) : ''), author: m.author, at: m.at });

onChatEvent((e) => {
  if (e.type === 'message') {
    const cur = messageCache.get(e.message.channelId);
    if (cur && !cur.some((m) => m.id === e.message.id)) messageCache.set(e.message.channelId, [...cur, e.message]);
    const pv = previewCache.get(e.teamId) ?? {};
    previewCache.set(e.teamId, { ...pv, [e.message.channelId]: digestMsg(e.message) });
  }
  if (e.type === 'message-changed') {
    const cur = messageCache.get(e.message.channelId);
    if (cur) {
      messageCache.set(e.message.channelId, e.message.deletedAt || e.message.at === ''
        ? cur.filter((m) => m.id !== e.message.id)
        : cur.map((m) => (m.id === e.message.id ? e.message : m)));
    }
  }
});

/* ── local (preview) store ── */

interface LocalStore { channels: Record<string, Channel[]>; messages: Record<string, ChatMessage[]>; reads: Record<string, string> }
const LS_KEY = 'exponential-chat';
const localLoad = (): LocalStore => { try { return { channels: {}, messages: {}, reads: {}, ...JSON.parse(localStorage.getItem(LS_KEY) ?? '{}') }; } catch { return { channels: {}, messages: {}, reads: {} }; } };
const localSave = (s: LocalStore) => localStorage.setItem(LS_KEY, JSON.stringify(s));

/* ── row mapping ── */

type MessageRow = { id: string; channel_id: string; team_id: string; author: string | null; body: string; attachments: Attachment[] | null; reactions: Record<string, string[]> | null; edited_at: string | null; deleted_at: string | null; created_at: string };
const toMessage = (r: MessageRow): ChatMessage => ({ id: r.id, channelId: r.channel_id, author: r.author ?? undefined, body: r.body, attachments: r.attachments ?? undefined, reactions: r.reactions ?? undefined, editedAt: r.edited_at ?? undefined, deletedAt: r.deleted_at ?? undefined, at: r.created_at });

/* ── channels ── */

export async function fetchChat(teamId: string, me: string, cloud: boolean): Promise<Channel[]> {
  if (!cloud) {
    const s = localLoad();
    let chs = s.channels[teamId];
    if (!chs || !chs.length) {
      chs = [{ id: uid(), name: 'general', private: false, unread: 0 }];
      s.channels[teamId] = chs;
      localSave(s);
    }
    return chs.map((c) => ({ ...c, unread: countLocalUnread(s, teamId, c.id, me) }));
  }
  const { data, error } = await supabase.rpc('chat_state', { t: teamId });
  if (error) throw error;
  const chs = (data as { id: string; name: string; topic: string | null; private: boolean; createdBy: string | null; members: string[] | null; lastRead: string | null; unread: number; lastAt: string | null }[])
    .map((c) => ({ id: c.id, name: c.name, topic: c.topic ?? undefined, private: c.private, createdBy: c.createdBy ?? undefined, members: c.members ?? undefined, lastRead: c.lastRead ?? undefined, unread: Number(c.unread), lastAt: c.lastAt ?? undefined }));
  if (!chs.length) {
    // First opener seeds #general; the unique (team_id, name) index settles a race.
    const ch = { id: uid(), team_id: teamId, name: 'general', is_private: false, created_by: me };
    const { error: e } = await supabase.from('channels').insert(ch);
    if (!e) return fetchChat(teamId, me, cloud);
    return fetchChat(teamId, me, cloud); // lost the race — the winner's row is there now
  }
  return chs;
}

const countLocalUnread = (s: LocalStore, teamId: string, channelId: string, me: string) => {
  const read = s.reads[channelId] ?? '';
  return (s.messages[channelId] ?? []).filter((m) => m.author !== me && m.at > read).length;
};

export async function createChannel(teamId: string, me: string, name: string, isPrivate: boolean, members: string[], cloud: boolean): Promise<void> {
  const id = uid();
  if (!cloud) {
    const s = localLoad();
    s.channels[teamId] = [...(s.channels[teamId] ?? []), { id, name, private: isPrivate, createdBy: me, members: isPrivate ? [me, ...members.filter((m) => m !== me)] : undefined, unread: 0 }];
    localSave(s);
    emit({ type: 'channels', teamId });
    return;
  }
  const { error } = await supabase.from('channels').insert({ id, team_id: teamId, name, is_private: isPrivate, created_by: me });
  if (error) throw error;
  if (isPrivate) {
    const rows = [me, ...members.filter((m) => m !== me)].map((u) => ({ channel_id: id, user_id: u }));
    const { error: e } = await supabase.from('channel_members').insert(rows);
    if (e) throw e;
  }
  emit({ type: 'channels', teamId });
}

export async function updateChannel(teamId: string, id: string, patch: { name?: string; topic?: string }, cloud: boolean) {
  if (!cloud) {
    const s = localLoad();
    s.channels[teamId] = (s.channels[teamId] ?? []).map((c) => (c.id === id ? { ...c, ...patch } : c));
    localSave(s); emit({ type: 'channels', teamId });
    return;
  }
  const { error } = await supabase.from('channels').update(patch).eq('id', id);
  if (error) throw error;
  emit({ type: 'channels', teamId });
}

export async function deleteChannel(teamId: string, id: string, cloud: boolean) {
  if (!cloud) {
    const s = localLoad();
    s.channels[teamId] = (s.channels[teamId] ?? []).filter((c) => c.id !== id);
    delete s.messages[id];
    localSave(s); emit({ type: 'channels', teamId });
    return;
  }
  const { error } = await supabase.from('channels').delete().eq('id', id);
  if (error) throw error;
  emit({ type: 'channels', teamId });
}

export async function setChannelMembers(teamId: string, id: string, members: string[], cloud: boolean) {
  if (!cloud) {
    const s = localLoad();
    s.channels[teamId] = (s.channels[teamId] ?? []).map((c) => (c.id === id ? { ...c, members } : c));
    localSave(s); emit({ type: 'channels', teamId });
    return;
  }
  const { data: cur, error } = await supabase.from('channel_members').select('user_id').eq('channel_id', id);
  if (error) throw error;
  const have = new Set((cur as { user_id: string }[]).map((r) => r.user_id));
  const want = new Set(members);
  const add = members.filter((m) => !have.has(m)).map((u) => ({ channel_id: id, user_id: u }));
  const drop = [...have].filter((u) => !want.has(u));
  if (add.length) { const { error: e } = await supabase.from('channel_members').insert(add); if (e) throw e; }
  if (drop.length) { const { error: e } = await supabase.from('channel_members').delete().eq('channel_id', id).in('user_id', drop); if (e) throw e; }
  emit({ type: 'channels', teamId });
}

export async function markRead(teamId: string, channelId: string, me: string, cloud: boolean) {
  if (!cloud) {
    const s = localLoad();
    s.reads[channelId] = new Date().toISOString();
    localSave(s);
    return;
  }
  await supabase.from('channel_members').upsert({ channel_id: channelId, user_id: me, last_read_at: new Date().toISOString() }, { onConflict: 'channel_id,user_id' });
}

/* ── direct messages: a DM is a private channel named dm:<a>|<b> (ids sorted), so two
   people opening the same DM at once converge on the unique (team_id, name) index. ── */

export const dmName = (a: string, b: string) => `dm:${[a, b].sort().join('|')}`;
export const isDm = (c: Pick<Channel, 'name'>) => c.name.startsWith('dm:');
export const dmOther = (c: Channel, me: string) => c.members?.find((id) => id !== me) ?? me;

export async function openDm(teamId: string, me: string, other: string, cloud: boolean): Promise<string> {
  const name = dmName(me, other);
  if (!cloud) {
    const s = localLoad();
    const existing = (s.channels[teamId] ?? []).find((c) => c.name === name);
    if (existing) return existing.id;
    const id = uid();
    s.channels[teamId] = [...(s.channels[teamId] ?? []), { id, name, private: true, createdBy: me, members: other === me ? [me] : [me, other], unread: 0 }];
    localSave(s);
    emit({ type: 'channels', teamId });
    return id;
  }
  const id = uid();
  const { error } = await supabase.from('channels').insert({ id, team_id: teamId, name, is_private: true, created_by: me });
  if (!error) {
    const rows = (other === me ? [me] : [me, other]).map((u) => ({ channel_id: id, user_id: u }));
    const { error: e } = await supabase.from('channel_members').insert(rows);
    if (e) throw e;
    emit({ type: 'channels', teamId });
    return id;
  }
  // Lost the race (other person, or another of my windows): theirs exists — wait out
  // their membership insert, which is what makes it visible to me.
  for (let i = 0; i < 5; i++) {
    const { data } = await supabase.from('channels').select('id').eq('team_id', teamId).eq('name', name).maybeSingle();
    if (data) { emit({ type: 'channels', teamId }); return (data as { id: string }).id; }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw error;
}

/* ── messages ── */

export async function fetchMessages(teamId: string, channelId: string, cloud: boolean, before?: string, limit = 60): Promise<ChatMessage[]> {
  if (!cloud) {
    const all = localLoad().messages[channelId] ?? [];
    const upTo = before ? all.filter((m) => m.at < before) : all;
    const page = upTo.slice(-limit);
    if (!before) messageCache.set(channelId, page);
    return page;
  }
  let q = supabase.from('messages').select('*').eq('channel_id', channelId).is('deleted_at', null).order('created_at', { ascending: false }).limit(limit);
  if (before) q = q.lt('created_at', before);
  const { data, error } = await q;
  if (error) throw error;
  const page = (data as MessageRow[]).map(toMessage).reverse();
  if (!before) {
    // refresh the cache, keeping anything realtime appended after this page was cut
    const cached = messageCache.get(channelId) ?? [];
    const newest = page[page.length - 1]?.at ?? '';
    const tail = cached.filter((m) => m.at > newest && !page.some((x) => x.id === m.id));
    messageCache.set(channelId, [...page, ...tail]);
  }
  return page;
}

export async function sendMessage(teamId: string, channelId: string, me: string, body: string, attachments: Attachment[] | undefined, cloud: boolean): Promise<ChatMessage> {
  const msg: ChatMessage = { id: uid(), channelId, author: me, body, attachments: attachments?.length ? attachments : undefined, at: new Date().toISOString() };
  if (!cloud) {
    const s = localLoad();
    s.messages[channelId] = [...(s.messages[channelId] ?? []), msg];
    localSave(s);
    emit({ type: 'message', teamId, message: msg });
    return msg;
  }
  const { error } = await supabase.from('messages').insert({ id: msg.id, channel_id: channelId, team_id: teamId, author: me, body, attachments: msg.attachments ?? null });
  if (error) throw error;
  return msg;
}

export async function editMessage(teamId: string, msg: ChatMessage, body: string, cloud: boolean) {
  const next = { ...msg, body, editedAt: new Date().toISOString() };
  if (!cloud) {
    const s = localLoad();
    s.messages[msg.channelId] = (s.messages[msg.channelId] ?? []).map((m) => (m.id === msg.id ? next : m));
    localSave(s);
    emit({ type: 'message-changed', teamId, message: next });
    return;
  }
  const { error } = await supabase.from('messages').update({ body, edited_at: next.editedAt }).eq('id', msg.id);
  if (error) throw error;
  emit({ type: 'message-changed', teamId, message: next }); // realtime echoes the same patch later — idempotent
}

export async function deleteMessage(teamId: string, msg: ChatMessage, cloud: boolean) {
  if (!cloud) {
    const s = localLoad();
    s.messages[msg.channelId] = (s.messages[msg.channelId] ?? []).filter((m) => m.id !== msg.id);
    localSave(s);
    emit({ type: 'message-changed', teamId, message: { ...msg, deletedAt: new Date().toISOString() } });
    return;
  }
  const { error } = await supabase.from('messages').update({ deleted_at: new Date().toISOString() }).eq('id', msg.id);
  if (error) throw error;
  emit({ type: 'message-changed', teamId, message: { ...msg, deletedAt: new Date().toISOString() } });
}

/** Toggle my reaction. Whole-column read-modify-write: simultaneous reactors are rare
 *  enough that last-writer-wins on one message's jsonb is an acceptable trade. */
export async function toggleReaction(teamId: string, msg: ChatMessage, emoji: string, me: string, cloud: boolean) {
  const apply = (r: Record<string, string[]> | undefined): Record<string, string[]> | undefined => {
    const next = { ...(r ?? {}) };
    const cur = next[emoji] ?? [];
    if (cur.includes(me)) {
      const left = cur.filter((u) => u !== me);
      if (left.length) next[emoji] = left; else delete next[emoji];
    } else next[emoji] = [...cur, me];
    return Object.keys(next).length ? next : undefined;
  };
  if (!cloud) {
    const s = localLoad();
    let out: ChatMessage | null = null;
    s.messages[msg.channelId] = (s.messages[msg.channelId] ?? []).map((m) => (m.id === msg.id ? (out = { ...m, reactions: apply(m.reactions) }) : m));
    localSave(s);
    if (out) emit({ type: 'message-changed', teamId, message: out });
    return;
  }
  const { data, error } = await supabase.from('messages').select('reactions').eq('id', msg.id).single();
  if (error) throw error;
  const reactions = apply((data as { reactions: Record<string, string[]> | null }).reactions ?? undefined) ?? null;
  const { error: e } = await supabase.from('messages').update({ reactions }).eq('id', msg.id);
  if (e) throw e;
  emit({ type: 'message-changed', teamId, message: { ...msg, reactions: reactions ?? undefined } });
}

/** One line per conversation for the iMessage-style list: the latest message of each
 *  channel (one query for all of them; local mode reads the store). */
export async function fetchPreviews(teamId: string, cloud: boolean): Promise<Record<string, { body: string; author?: string; at: string }>> {
  const out: Record<string, { body: string; author?: string; at: string }> = { ...(previewCache.get(teamId) ?? {}) };
  const digest = (m: ChatMessage) => ({ body: m.body || (m.attachments?.length ? (m.attachments[0].type.startsWith('image/') ? '📷 Image' : m.attachments[0].name) : ''), author: m.author, at: m.at });
  if (!cloud) {
    const st = localLoad();
    for (const [chId, msgs] of Object.entries(st.messages)) {
      const last = msgs[msgs.length - 1];
      if (last) out[chId] = digest(last);
    }
    previewCache.set(teamId, out);
    return out;
  }
  const { data, error } = await supabase.from('messages')
    .select('id, channel_id, team_id, author, body, attachments, edited_at, deleted_at, created_at')
    .eq('team_id', teamId).is('deleted_at', null)
    .order('created_at', { ascending: false }).limit(200);
  if (error) return out;
  const seen = new Set<string>();
  for (const r of data as MessageRow[]) {
    if (!seen.has(r.channel_id)) { seen.add(r.channel_id); out[r.channel_id] = digest(toMessage(r)); }
  }
  previewCache.set(teamId, out);
  return out;
}

/* ── attachments ── */

const MAX_FILE = 25 * 1024 * 1024;

/** Pasted/dropped images are downscaled like notes images (the egress lesson).
 *  GIFs pass through untouched (re-encoding kills the animation) and PNGs stay PNG
 *  (JPEG would flatten transparency onto black); photos go to JPEG q0.82 at ≤1600px. */
async function shrinkImage(file: File): Promise<{ blob: Blob; w: number; h: number }> {
  const bmp = await createImageBitmap(file);
  if (file.type === 'image/gif') return { blob: file, w: bmp.width, h: bmp.height };
  const big = Math.max(bmp.width, bmp.height) > 1600;
  if (!big && (file.size < 150 * 1024 || file.type === 'image/png')) return { blob: file, w: bmp.width, h: bmp.height };
  const scale = big ? 1600 / Math.max(bmp.width, bmp.height) : 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
  const blob = await new Promise<Blob>((res) => canvas.toBlob((b) => res(b!), type, 0.82));
  return blob.size < file.size ? { blob, w: canvas.width, h: canvas.height } : { blob: file, w: bmp.width, h: bmp.height };
}

export async function uploadChatFile(teamId: string, file: File, cloud: boolean): Promise<Attachment> {
  if (file.size > MAX_FILE) throw new Error('Files can be up to 25 MB');
  const isImage = file.type.startsWith('image/');
  let blob: Blob = file;
  let dims: { w?: number; h?: number } = {};
  if (isImage) {
    const s = await shrinkImage(file);
    blob = s.blob; dims = { w: s.w, h: s.h };
  }
  if (!cloud) {
    const url: string = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result as string); r.readAsDataURL(blob); });
    return { path: url, name: file.name, size: blob.size, type: blob.type || file.type, ...dims };
  }
  const path = `${teamId}/${uid()}-${file.name.replace(/[^\w.\- ]+/g, '_').slice(0, 80)}`;
  const { error } = await supabase.storage.from('chat').upload(path, blob, { contentType: blob.type || file.type, upsert: false });
  if (error) throw error;
  return { path, name: file.name, size: blob.size, type: blob.type || file.type, ...dims };
}

const urlCache = new Map<string, { url: string; until: number }>();
export async function attachmentUrl(att: Attachment, cloud: boolean): Promise<string> {
  if (!cloud || att.path.startsWith('data:')) return att.path;
  const hit = urlCache.get(att.path);
  if (hit && hit.until > Date.now()) return hit.url;
  const { data, error } = await supabase.storage.from('chat').createSignedUrl(att.path, 3600);
  if (error) throw error;
  urlCache.set(att.path, { url: data.signedUrl, until: Date.now() + 3300 * 1000 });
  return data.signedUrl;
}

/* ── realtime ── */

/** One subscription per team, owned by App: pumps row events into the bus above. */
export function subscribeChat(teamId: string, cloud: boolean): () => void {
  if (!cloud) return () => {};
  const ch = supabase.channel(`chat:${teamId}`);
  ch.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `team_id=eq.${teamId}` }, (p) => {
    emit({ type: 'message', teamId, message: toMessage(p.new as MessageRow) });
  });
  ch.on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages', filter: `team_id=eq.${teamId}` }, (p) => {
    emit({ type: 'message-changed', teamId, message: toMessage(p.new as MessageRow) });
  });
  ch.on('postgres_changes', { event: '*', schema: 'public', table: 'channels', filter: `team_id=eq.${teamId}` }, () => emit({ type: 'channels', teamId }));
  ch.subscribe();
  return () => { supabase.removeChannel(ch); };
}
