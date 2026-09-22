import { supabase } from './cloud';
import type { CalendarEvent } from './types';

/**
 * Meetings: recordings, transcripts and shared calendars. Rows live in `meetings`
 * (RLS: owner / people in `access` / whole team when `is_open`), audio in the private
 * 'meetings' storage bucket at `<meetingId>/audio.webm`, uploaded once and only
 * downloaded on play. Transcription happens ON DEVICE (see transcribe.ts) — audio never
 * leaves the machine except as that one backup upload. The browser preview keeps rows
 * in localStorage and audio in IndexedDB, same API.
 */

export interface Segment { t0: number; t1: number; text: string }
export interface Meeting {
  id: string; owner?: string; title: string; startedAt: string; durationSecs?: number;
  audioPath?: string; transcript?: Segment[]; summary?: string;
  status: 'recorded' | 'transcribing' | 'ready' | 'error';
  isOpen: boolean; access: string[];
}
export interface SharedCalendar { userId: string; events: CalendarEvent[]; updatedAt: string }

/* ── local (preview) store ── */

const LS_KEY = 'exponential-meetings';
type LocalStore = Record<string, Meeting[]>; // teamId → meetings
const localLoad = (): LocalStore => { try { return JSON.parse(localStorage.getItem(LS_KEY) ?? '{}'); } catch { return {}; } };
const localSave = (s: LocalStore) => localStorage.setItem(LS_KEY, JSON.stringify(s));

/* audio blobs for local mode / offline cache */
const idb = () => new Promise<IDBDatabase>((res, rej) => {
  const r = indexedDB.open('exponential-media', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('audio');
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
export async function putLocalAudio(id: string, blob: Blob) {
  const db = await idb();
  await new Promise((res, rej) => { const tx = db.transaction('audio', 'readwrite'); tx.objectStore('audio').put(blob, id); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
}
export async function getLocalAudio(id: string): Promise<Blob | undefined> {
  const db = await idb();
  return new Promise((res, rej) => { const q = db.transaction('audio').objectStore('audio').get(id); q.onsuccess = () => res(q.result ?? undefined); q.onerror = () => rej(q.error); });
}
export async function deleteLocalAudio(id: string) {
  const db = await idb();
  await new Promise((res) => { const tx = db.transaction('audio', 'readwrite'); tx.objectStore('audio').delete(id); tx.oncomplete = res; tx.onerror = res; });
}

/* ── row mapping ── */

type MeetingRow = {
  id: string; team_id: string; owner: string | null; title: string; started_at: string;
  duration_secs: number | null; audio_path: string | null; transcript: Segment[] | null;
  summary: string | null; status: Meeting['status']; is_open: boolean; access: string[];
};
const toMeeting = (r: MeetingRow): Meeting => ({
  id: r.id, owner: r.owner ?? undefined, title: r.title, startedAt: r.started_at,
  durationSecs: r.duration_secs ?? undefined, audioPath: r.audio_path ?? undefined,
  transcript: r.transcript ?? undefined, summary: r.summary ?? undefined,
  status: r.status, isOpen: r.is_open, access: r.access ?? [],
});

/* ── CRUD ── */

export async function fetchMeetings(teamId: string, cloud: boolean): Promise<Meeting[]> {
  if (!cloud) return (localLoad()[teamId] ?? []).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const { data, error } = await supabase.from('meetings').select('*').eq('team_id', teamId).order('started_at', { ascending: false });
  if (error) throw error;
  return (data as MeetingRow[]).map(toMeeting);
}

export async function createMeeting(teamId: string, me: string, m: Omit<Meeting, 'owner'>, cloud: boolean): Promise<void> {
  if (!cloud) {
    const s = localLoad();
    s[teamId] = [{ ...m, owner: me }, ...(s[teamId] ?? [])];
    localSave(s);
    return;
  }
  const { error } = await supabase.from('meetings').insert({
    id: m.id, team_id: teamId, owner: me, title: m.title, started_at: m.startedAt,
    duration_secs: m.durationSecs ?? null, audio_path: m.audioPath ?? null,
    transcript: m.transcript ?? null, summary: m.summary ?? null, status: m.status,
    is_open: m.isOpen, access: m.access,
  });
  if (error) throw error;
}

export async function updateMeeting(teamId: string, id: string, patch: Partial<Meeting>, cloud: boolean): Promise<void> {
  if (!cloud) {
    const s = localLoad();
    s[teamId] = (s[teamId] ?? []).map((m) => (m.id === id ? { ...m, ...patch } : m));
    localSave(s);
    return;
  }
  const row: Record<string, unknown> = {};
  if (patch.title !== undefined) row.title = patch.title;
  if (patch.durationSecs !== undefined) row.duration_secs = patch.durationSecs;
  if (patch.audioPath !== undefined) row.audio_path = patch.audioPath;
  if (patch.transcript !== undefined) row.transcript = patch.transcript;
  if (patch.summary !== undefined) row.summary = patch.summary;
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.isOpen !== undefined) row.is_open = patch.isOpen;
  if (patch.access !== undefined) row.access = patch.access;
  const { error } = await supabase.from('meetings').update(row).eq('id', id);
  if (error) throw error;
}

export async function deleteMeeting(teamId: string, m: Meeting, cloud: boolean): Promise<void> {
  deleteLocalAudio(m.id).catch(() => {});
  window.exponential?.meetingDelete?.(m.id);
  if (!cloud) {
    const s = localLoad();
    s[teamId] = (s[teamId] ?? []).filter((x) => x.id !== m.id);
    localSave(s);
    return;
  }
  if (m.audioPath) await supabase.storage.from('meetings').remove([m.audioPath]);
  const { error } = await supabase.from('meetings').delete().eq('id', m.id);
  if (error) throw error;
}

/* ── audio ── */

export async function uploadMeetingAudio(meetingId: string, blob: Blob, cloud: boolean): Promise<string | undefined> {
  if (!cloud) { await putLocalAudio(meetingId, blob); return undefined; }
  const path = `${meetingId}/audio.webm`;
  const { error } = await supabase.storage.from('meetings').upload(path, blob, { contentType: blob.type || 'audio/webm', upsert: true });
  if (error) throw error;
  putLocalAudio(meetingId, blob).catch(() => {}); // keep the local copy as a play cache
  return path;
}

export async function meetingAudioUrl(m: Meeting, cloud: boolean): Promise<string | null> {
  const local = await getLocalAudio(m.id).catch(() => undefined);
  if (local) return URL.createObjectURL(local);
  if (cloud && m.audioPath) {
    const { data, error } = await supabase.storage.from('meetings').createSignedUrl(m.audioPath, 3600);
    if (error) return null;
    return data.signedUrl;
  }
  return null;
}

/* ── shared calendars ── */

export async function pushCalendarShare(teamId: string, me: string, events: SharedCalendar['events'], cloud: boolean) {
  if (!cloud) return;
  await supabase.from('calendar_shares').upsert(
    { team_id: teamId, user_id: me, events, updated_at: new Date().toISOString() },
    { onConflict: 'team_id,user_id' },
  );
}

export async function removeCalendarShare(teamId: string, me: string, cloud: boolean) {
  if (!cloud) return;
  await supabase.from('calendar_shares').delete().eq('team_id', teamId).eq('user_id', me);
}

export async function fetchCalendarShares(teamId: string, cloud: boolean): Promise<SharedCalendar[]> {
  if (!cloud) return [];
  const { data, error } = await supabase.from('calendar_shares').select('*').eq('team_id', teamId);
  if (error) throw error;
  return (data as { user_id: string; events: SharedCalendar['events']; updated_at: string }[])
    .map((r) => ({ userId: r.user_id, events: r.events ?? [], updatedAt: r.updated_at }));
}

/* ── realtime (page-scoped) ── */

export function subscribeMeetings(teamId: string, cloud: boolean, onChange: () => void): () => void {
  if (!cloud) return () => {};
  const ch = supabase.channel(`meetings:${teamId}`);
  ch.on('postgres_changes', { event: '*', schema: 'public', table: 'meetings', filter: `team_id=eq.${teamId}` }, onChange);
  ch.on('postgres_changes', { event: '*', schema: 'public', table: 'calendar_shares', filter: `team_id=eq.${teamId}` }, onChange);
  ch.subscribe();
  return () => { supabase.removeChannel(ch); };
}
