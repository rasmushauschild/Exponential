import type { Segment } from './meetings';
import type { Enrolled } from './transcribe';

/**
 * Cloud transcription via AssemblyAI — the "just works" path for speaker separation
 * (battle-tested diarization, Danish/English auto-detect). The SHIPPED DEFAULT is
 * transcribeViaBackend: the 'transcribe' edge function holds the API key server-side, so
 * every signed-in member gets cloud transcription with zero setup and no key in the
 * binary. transcribeCloud is the optional override for teams that set their own key in
 * Team settings. Either way the cloud only groups voices (Speaker A/B/C); enrolled voice
 * prints then name those groups LOCALLY, so the naming stays on-device.
 */

const API = 'https://api.assemblyai.com/v2';

type Utterance = { speaker: string; start: number; end: number; text: string };
type AaiResult = { status: string; error?: string; text?: string; audio_duration?: number; utterances?: Utterance[] };

function toSegments(result: AaiResult): Segment[] {
  const utterances = result.utterances ?? [];
  let segments: Segment[] = utterances.map((u) => ({
    t0: u.start / 1000,
    t1: u.end / 1000,
    text: u.text.trim(),
    who: `Speaker ${u.speaker}`,
  })).filter((s) => s.text);
  if (!segments.length && result.text) segments = [{ t0: 0, t1: result.audio_duration ?? 0, text: result.text }];
  return segments;
}

async function nameGroups(blob: Blob, segments: Segment[], enrolled: Enrolled[], onProgress: (l: string) => void): Promise<Segment[]> {
  if (!enrolled.length || !segments.length) return segments;
  try {
    onProgress('Matching voices');
    const { nameSpeakerGroups } = await import('./transcribe');
    return await nameSpeakerGroups(blob, segments, enrolled);
  } catch { return segments; }
}

/** The SHIPPED path: no key in the app — the 'transcribe' edge function holds it and
 *  checks that the caller is a team member with access to this meeting. */
export async function transcribeViaBackend(
  meetingId: string,
  blob: Blob,
  enrolled: Enrolled[],
  onProgress: (label: string) => void,
): Promise<{ segments: Segment[]; text: string; durationSecs: number }> {
  const { supabase } = await import('./cloud');
  onProgress('Transcribing in the cloud');
  const start = await supabase.functions.invoke('transcribe', { body: { action: 'start', meetingId } });
  if (start.error) throw new Error(start.error.message ?? 'transcription service unavailable');
  const started = start.data as { id?: string; error?: string };
  if (!started.id) throw new Error(started.error ?? 'transcription service unavailable');

  let result: AaiResult;
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    const poll = await supabase.functions.invoke('transcribe', { body: { action: 'poll', id: started.id } });
    if (poll.error) throw new Error(poll.error.message ?? 'poll failed');
    result = poll.data as AaiResult;
    if (result.status === 'completed') break;
    if (result.status === 'error') throw new Error(result.error ?? 'cloud transcription failed');
  }
  let segments = toSegments(result);
  segments = await nameGroups(blob, segments, enrolled, onProgress);
  return { segments, text: result.text ?? segments.map((s) => s.text).join(' '), durationSecs: Math.round(result.audio_duration ?? (segments.at(-1)?.t1 ?? 0)) };
}

export async function transcribeCloud(
  blob: Blob,
  key: string,
  enrolled: Enrolled[],
  onProgress: (label: string) => void,
): Promise<{ segments: Segment[]; text: string; durationSecs: number }> {
  onProgress('Uploading audio');
  const up = await fetch(`${API}/upload`, { method: 'POST', headers: { authorization: key }, body: blob });
  if (!up.ok) throw new Error(`Upload failed (${up.status}) — check the transcription key in Team settings`);
  const { upload_url: audioUrl } = await up.json() as { upload_url: string };

  const start = await fetch(`${API}/transcript`, {
    method: 'POST',
    headers: { authorization: key, 'content-type': 'application/json' },
    body: JSON.stringify({ audio_url: audioUrl, speaker_labels: true, language_detection: true }),
  });
  if (!start.ok) throw new Error(`Transcription request failed (${start.status})`);
  const { id } = await start.json() as { id: string };

  onProgress('Transcribing in the cloud');
  let result: AaiResult;
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    const res = await fetch(`${API}/transcript/${id}`, { headers: { authorization: key } });
    if (!res.ok) throw new Error(`Transcription poll failed (${res.status})`);
    result = await res.json();
    if (result.status === 'completed') break;
    if (result.status === 'error') throw new Error(result.error ?? 'Cloud transcription failed');
  }

  let segments = toSegments(result);
  segments = await nameGroups(blob, segments, enrolled, onProgress);
  return { segments, text: result.text ?? segments.map((s) => s.text).join(' '), durationSecs: Math.round(result.audio_duration ?? (segments.at(-1)?.t1 ?? 0)) };
}
