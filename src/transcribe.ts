import type { Segment } from './meetings';

/**
 * On-device transcription: Whisper (base, multilingual) via transformers.js — free,
 * private, offline after the one-time model download (~80 MB, cached by the browser
 * cache API in the app's session data). WebGPU when available, WASM otherwise.
 * The module is imported lazily so the main bundle (and the widget) never pays for it.
 */

export type TranscribeProgress =
  | { phase: 'model'; pct: number }
  | { phase: 'decode' }
  | { phase: 'run'; pct: number }
  | { phase: 'speakers' };

const MODEL = 'onnx-community/whisper-base';

let asrPromise: Promise<(audio: Float32Array, opts: Record<string, unknown>) => Promise<unknown>> | null = null;

async function loadAsr(onProgress: (p: TranscribeProgress) => void) {
  if (!asrPromise) {
    asrPromise = (async () => {
      const { pipeline } = await import('@huggingface/transformers');
      const files = new Map<string, number>();
      const asr = await pipeline('automatic-speech-recognition', MODEL, {
        device: 'gpu' in navigator ? 'webgpu' : 'wasm',
        progress_callback: (p: { status?: string; file?: string; progress?: number }) => {
          if (p.status === 'progress' && p.file) {
            files.set(p.file, p.progress ?? 0);
            const vals = [...files.values()];
            onProgress({ phase: 'model', pct: Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) });
          }
        },
      } as never);
      return asr as unknown as (audio: Float32Array, opts: Record<string, unknown>) => Promise<unknown>;
    })().catch((e) => { asrPromise = null; throw e; });
  }
  return asrPromise;
}

/** Any audio the browser can decode (webm/mp3/m4a/wav/ogg) → mono 16 kHz PCM. */
async function decodeTo16k(blob: Blob): Promise<Float32Array> {
  const buf = await blob.arrayBuffer();
  const ctx = new AudioContext({ sampleRate: 16000 });
  try {
    const audio = await ctx.decodeAudioData(buf);
    const ch0 = audio.getChannelData(0);
    if (audio.numberOfChannels === 1) return ch0.slice();
    const ch1 = audio.getChannelData(1);
    const out = new Float32Array(audio.length);
    for (let i = 0; i < audio.length; i++) out[i] = (ch0[i] + ch1[i]) / 2;
    return out;
  } finally { ctx.close(); }
}

export async function transcribe(blob: Blob, onProgress: (p: TranscribeProgress) => void): Promise<{ segments: Segment[]; text: string; durationSecs: number }> {
  const asr = await loadAsr(onProgress);
  onProgress({ phase: 'decode' });
  const audio = await decodeTo16k(blob);
  const total = audio.length / 16000;
  onProgress({ phase: 'run', pct: 0 });
  const out = await asr(audio, {
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: true,
    // eslint-disable-next-line camelcase
    callback_function: undefined,
  }) as { text: string; chunks?: { timestamp: [number, number | null]; text: string }[] };
  onProgress({ phase: 'run', pct: 100 });
  const segments: Segment[] = (out.chunks ?? []).map((c) => ({
    t0: Math.max(0, c.timestamp[0] ?? 0),
    t1: Math.min(total, c.timestamp[1] ?? c.timestamp[0] ?? total),
    text: c.text.trim(),
  })).filter((s) => s.text);
  const text = out.text?.trim() ?? segments.map((s) => s.text).join(' ');
  return { segments: segments.length ? segments : text ? [{ t0: 0, t1: total, text }] : [], text, durationSecs: Math.round(total) };
}

/* ── speakers: on-device diarization (pyannote segmentation) + who-is-it matching
   (wespeaker embeddings vs each member's enrolled voice print). Everything here is
   OPTIONAL: any failure returns the transcript without speaker labels. ── */

const SEG_MODEL = 'onnx-community/pyannote-segmentation-3.0';
const EMB_MODEL = 'Xenova/wavlm-base-plus-sv'; // public x-vector model; wespeaker's repo is gated

/* eslint-disable @typescript-eslint/no-explicit-any */
let segP: Promise<{ processor: any; model: any }> | null = null;
let embP: Promise<{ processor: any; model: any }> | null = null;
async function loadSeg() {
  if (!segP) segP = (async () => {
    const { AutoProcessor, AutoModelForAudioFrameClassification } = await import('@huggingface/transformers');
    const processor = await AutoProcessor.from_pretrained(SEG_MODEL);
    const model = await AutoModelForAudioFrameClassification.from_pretrained(SEG_MODEL, { dtype: 'fp32' } as never);
    return { processor, model };
  })().catch((e) => { segP = null; throw e; });
  return segP;
}
async function loadEmb() {
  if (!embP) embP = (async () => {
    const { AutoProcessor, AutoModelForXVector } = await import('@huggingface/transformers');
    const processor = await AutoProcessor.from_pretrained(EMB_MODEL);
    const model = await AutoModelForXVector.from_pretrained(EMB_MODEL, { dtype: 'q8' } as never);
    return { processor, model };
  })().catch((e) => { embP = null; throw e; });
  return embP;
}

const l2 = (v: number[]) => { const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1; return v.map((x) => x / n); };
const cos = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0); // both l2-normalised

async function embed(audio: Float32Array): Promise<number[]> {
  const { processor, model } = await loadEmb();
  const inputs = await processor(audio);
  const out = await model(inputs);
  const t = (out.embeddings ?? out.logits ?? Object.values(out)[0]) as { data: Float32Array };
  return l2(Array.from(t.data));
}

/** ~8s of speech → a voice print for "Learn my voice". */
export async function voiceEmbedding(blob: Blob): Promise<number[]> {
  return embed(await decodeTo16k(blob));
}

export interface Enrolled { id: string; embedding: number[] }

/** Label whisper segments with who spoke.
 *  pyannote separates speakers reliably WITHIN each 30s window (it is built for real,
 *  single-channel meeting audio); windows overlap by 5s, so window-local speaker ids
 *  are STITCHED across the seam by time-overlap. Embeddings only break ties (a speaker
 *  silent across a seam) and match enrolled voice prints — they are NOT the primary
 *  clustering signal, because same-channel recordings make different people's
 *  embeddings too similar (that once merged everyone into one speaker). */
export async function labelSpeakers(audio: Float32Array, segments: Segment[], enrolled: Enrolled[]): Promise<Segment[]> {
  const SR = 16000;
  const { processor, model } = await loadSeg();
  type Turn = { start: number; end: number; win: number; local: number };
  const turns: Turn[] = [];
  const WIN = 30 * SR, HOP = 25 * SR;
  let winIdx = 0;
  for (let off = 0; off < audio.length; off += HOP, winIdx++) {
    const chunk = audio.subarray(off, Math.min(audio.length, off + WIN));
    if (chunk.length < SR * 0.8) break;
    const inputs = await processor(chunk);
    const out = await model(inputs);
    const res = processor.post_process_speaker_diarization(out.logits, chunk.length) as { id: number; start: number; end: number; confidence: number }[][];
    for (const seg of res[0] ?? []) {
      if (seg.id === 0 || seg.end - seg.start < 0.4) continue; // 0 = no speaker
      turns.push({ start: off / SR + seg.start, end: off / SR + seg.end, win: winIdx, local: seg.id });
    }
    if (off + WIN >= audio.length) break;
  }
  if (!turns.length) return segments;

  const key = (t: Turn) => `${t.win}:${t.local}`;
  const byGroup = new Map<string, Turn[]>();
  for (const t of turns) { const k = key(t); if (!byGroup.has(k)) byGroup.set(k, []); byGroup.get(k)!.push(t); }

  // stitch: a group joins the cluster of any previous-window turn it overlaps in time
  const clusterOf = new Map<string, number>();
  let nClusters = 0;
  const orderedKeys = [...byGroup.keys()].sort((a, b) => Number(a.split(':')[0]) - Number(b.split(':')[0]));
  const unresolved: string[] = [];
  for (const k of orderedKeys) {
    const win = Number(k.split(':')[0]);
    if (win === 0) { clusterOf.set(k, nClusters++); continue; }
    const mine = byGroup.get(k)!;
    let linked = -1;
    for (const [ok, oturns] of byGroup) {
      if (Number(ok.split(':')[0]) !== win - 1) continue;
      const oc = clusterOf.get(ok);
      if (oc === undefined || oc === -1) continue;
      if (oturns.some((p) => mine.some((m) => Math.min(m.end, p.end) - Math.max(m.start, p.start) > 0.3))) { linked = oc; break; }
    }
    if (linked >= 0) clusterOf.set(k, linked);
    else { clusterOf.set(k, -1); unresolved.push(k); }
  }

  // embeddings: one per group (middle of its longest turn), used for tie-breaks + enrolment
  const groupEmb = new Map<string, number[] | null>();
  const embFor = async (k: string) => {
    if (groupEmb.has(k)) return groupEmb.get(k)!;
    const t = [...byGroup.get(k)!].sort((a, b) => (b.end - b.start) - (a.end - a.start))[0];
    const mid = (t.start + t.end) / 2, half = Math.min(3, (t.end - t.start) / 2);
    const a = audio.subarray(Math.max(0, Math.floor((mid - half) * SR)), Math.floor((mid + half) * SR));
    const e = a.length >= SR * 0.8 ? await embed(a).catch(() => null) : null;
    groupEmb.set(k, e);
    return e;
  };
  const clusterRep = new Map<number, string>(); // cluster → first group key
  for (const k of orderedKeys) { const c = clusterOf.get(k)!; if (c >= 0 && !clusterRep.has(c)) clusterRep.set(c, k); }
  for (const k of unresolved) {
    const e = await embFor(k);
    let best = -1, bestSim = 0.72; // strict: joining wrongly merges people, a miss just adds a speaker
    if (e) {
      for (const [c, rk] of clusterRep) {
        const re = await embFor(rk);
        if (re) { const sim = cos(e, re); if (sim > bestSim) { best = c; bestSim = sim; } }
      }
    }
    const c = best >= 0 ? best : nClusters++;
    clusterOf.set(k, c);
    if (!clusterRep.has(c)) clusterRep.set(c, k);
  }

  // clusters → labels: enrolled voice prints first, then Speaker N by first appearance
  const label = new Map<number, string>();
  let anon = 0;
  for (const k of orderedKeys) {
    const c = clusterOf.get(k)!;
    if (label.has(c)) continue;
    let who = '';
    if (enrolled.length) {
      const e = await embFor(clusterRep.get(c) ?? k);
      if (e) {
        let sim = 0.6;
        for (const en of enrolled) { const s2 = cos(e, l2(en.embedding)); if (s2 > sim) { who = en.id; sim = s2; } }
      }
    }
    label.set(c, who || `Speaker ${++anon}`);
  }

  // each whisper segment takes the speaker whose turns overlap it most
  return segments.map((s2) => {
    const share = new Map<number, number>();
    for (const t of turns) {
      const ov = Math.min(s2.t1, t.end) - Math.max(s2.t0, t.start);
      if (ov > 0.15) share.set(clusterOf.get(key(t))!, (share.get(clusterOf.get(key(t))!) ?? 0) + ov);
    }
    let best = -1, bestOv = 0.2;
    for (const [c, ov] of share) if (ov > bestOv) { best = c; bestOv = ov; }
    const who = best >= 0 ? label.get(best) : undefined;
    return who ? { ...s2, who } : s2;
  });
}

/** The whole pipeline MeetingsPage uses: transcript, speaker labels, auto title. */
export async function transcribeWithSpeakers(blob: Blob, enrolled: Enrolled[], onProgress: (p: TranscribeProgress) => void):
  Promise<{ segments: Segment[]; text: string; durationSecs: number }> {
  const asr = await loadAsr(onProgress);
  onProgress({ phase: 'decode' });
  const audio = await decodeTo16k(blob);
  const total = audio.length / 16000;
  onProgress({ phase: 'run', pct: 0 });
  const out = await asr(audio, { chunk_length_s: 30, stride_length_s: 5, return_timestamps: true }) as { text: string; chunks?: { timestamp: [number, number | null]; text: string }[] };
  const raw: Segment[] = (out.chunks ?? []).map((c) => ({
    t0: Math.max(0, c.timestamp[0] ?? 0),
    t1: Math.min(total, c.timestamp[1] ?? c.timestamp[0] ?? total),
    text: c.text.trim(),
  })).filter((x) => x.text);
  const text = out.text?.trim() ?? raw.map((x) => x.text).join(' ');
  let segments = raw.length ? raw : text ? [{ t0: 0, t1: total, text }] : [];
  try {
    onProgress({ phase: 'speakers' });
    segments = await labelSpeakers(audio, segments, enrolled);
  } catch (e) { console.warn('[speakers] skipped:', e); }
  return { segments, text, durationSecs: Math.round(total) };
}

/* ── automatic naming: the most talked-about words become the title ── */

const STOP = new Set(('the a an and or but if then else for to of in on at by with from as is are was were be been being do does did done have has had having i you he she it we they me him her us them my your his its our their this that these those there here what which who whom when where why how not no yes so just also very really quite about into over under again once more most other some such only own same than too can will would should could may might must shall let lets ok okay right well now going go get got make made take took come came know knew think thought say said see saw want wanted need needed talk talked look looked way thing things stuff kind sort bit lot yeah um uh hmm like ' +
  'og i på det den der de vi han hun jeg du man mig dig ham hende os jer dem min din sin vores jeres deres dette disse hvad hvem hvor hvorfor hvordan når da så men eller hvis at som er var være blevet bliver har havde have gør gjorde kan kunne vil ville skal skulle må måtte ikke nej ja også kun meget mere mest andet andre samme end for til af fra med om over under igen bare lige noget nogen ingen alt alle den her den der altså jo vel okay hej tak').split(/\s+/));

export function autoTitle(text: string, fallback: string): string {
  const words = text.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/).filter((w) => w.length >= 4 && !STOP.has(w));
  if (words.length < 5) return fallback;
  const freq = new Map<string, number>();
  for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1);
  const top = [...freq.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, 3)
    .map(([w]) => w[0].toUpperCase() + w.slice(1));
  if (!top.length) return fallback;
  return top.join(' · ').slice(0, 60);
}
