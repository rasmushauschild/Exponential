import type { Segment } from './meetings';
import type { Enrolled } from './transcribe';

/**
 * Cloud transcription via AssemblyAI — the "just works" path for speaker separation
 * (battle-tested diarization, Danish/English auto-detect). Opt-in: it only runs when a
 * team API key is set in Team settings, because meeting audio leaves the device for
 * processing. The cloud groups voices (Speaker A/B/C); enrolled voice prints then name
 * those groups LOCALLY, so the naming stays on-device.
 */

const API = 'https://api.assemblyai.com/v2';

type Utterance = { speaker: string; start: number; end: number; text: string };

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
  let result: { status: string; error?: string; text?: string; audio_duration?: number; utterances?: Utterance[] };
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    const res = await fetch(`${API}/transcript/${id}`, { headers: { authorization: key } });
    if (!res.ok) throw new Error(`Transcription poll failed (${res.status})`);
    result = await res.json();
    if (result.status === 'completed') break;
    if (result.status === 'error') throw new Error(result.error ?? 'Cloud transcription failed');
  }

  const utterances = result.utterances ?? [];
  let segments: Segment[] = utterances.map((u) => ({
    t0: u.start / 1000,
    t1: u.end / 1000,
    text: u.text.trim(),
    who: `Speaker ${u.speaker}`,
  })).filter((s) => s.text);
  if (!segments.length && result.text) segments = [{ t0: 0, t1: result.audio_duration ?? 0, text: result.text }];

  // name the cloud's A/B/C groups from enrolled voice prints, locally
  if (enrolled.length && segments.length) {
    try {
      onProgress('Matching voices');
      const { nameSpeakerGroups } = await import('./transcribe');
      segments = await nameSpeakerGroups(blob, segments, enrolled);
    } catch { /* names stay Speaker A/B/C — assignable by hand */ }
  }

  return { segments, text: result.text ?? segments.map((s) => s.text).join(' '), durationSecs: Math.round(result.audio_duration ?? (segments.at(-1)?.t1 ?? 0)) };
}
