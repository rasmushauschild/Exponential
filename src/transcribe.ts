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

/** Label whisper segments with who spoke: diarize in 30s windows, embed each turn,
 *  cluster turns globally, then match clusters to enrolled voice prints.
 *  `who` = a user id when a print matches, else "Speaker N". */
export async function labelSpeakers(audio: Float32Array, segments: Segment[], enrolled: Enrolled[]): Promise<Segment[]> {
  const SR = 16000;
  const { processor, model } = await loadSeg();
  type Turn = { start: number; end: number; emb?: number[]; cluster?: number };
  const turns: Turn[] = [];
  const WIN = 30 * SR, HOP = 25 * SR;
  for (let off = 0; off < audio.length; off += HOP) {
    const chunk = audio.subarray(off, Math.min(audio.length, off + WIN));
    if (chunk.length < SR) break;
    const inputs = await processor(chunk);
    const out = await model(inputs);
    const res = processor.post_process_speaker_diarization(out.logits, chunk.length) as { id: number; start: number; end: number; confidence: number }[][];
    for (const seg of res[0] ?? []) {
      if (seg.id === 0 || seg.end - seg.start < 0.5) continue; // 0 = no speaker
      const start = off / SR + seg.start, end = off / SR + seg.end;
      if (turns.some((t) => t.start <= start + 0.1 && t.end >= end - 0.1)) continue; // overlap dupe
      turns.push({ start, end });
    }
    if (off + WIN >= audio.length) break;
  }
  // one embedding per turn (capped at 6s of its middle), then greedy clustering
  for (const t of turns) {
    const mid = (t.start + t.end) / 2, half = Math.min(3, (t.end - t.start) / 2);
    const a = audio.subarray(Math.floor((mid - half) * SR), Math.floor((mid + half) * SR));
    if (a.length >= SR * 0.8) { try { t.emb = await embed(a); } catch { /* too short/odd — stays unclustered */ } }
  }
  const clusters: { mean: number[]; n: number }[] = [];
  for (const t of turns) {
    if (!t.emb) continue;
    let best = -1, bestSim = 0.65; // same voice ≈0.9+, different ≈0.5 on wavlm-sv
    clusters.forEach((c, i) => { const sim = cos(t.emb!, l2(c.mean)); if (sim > bestSim) { best = i; bestSim = sim; } });
    if (best === -1) { clusters.push({ mean: [...t.emb], n: 1 }); t.cluster = clusters.length - 1; }
    else { const c = clusters[best]; c.mean = c.mean.map((x, i) => x + t.emb![i]); c.n++; t.cluster = best; }
  }
  // clusters → names: enrolled prints first, anonymous numbering for the rest
  const label = new Map<number, string>();
  let anon = 0;
  clusters.forEach((c, i) => {
    const mean = l2(c.mean.map((x) => x / c.n));
    let who = '', sim = 0.6;
    for (const e of enrolled) { const s2 = cos(mean, l2(e.embedding)); if (s2 > sim) { who = e.id; sim = s2; } }
    label.set(i, who || `Speaker ${++anon}`);
  });
  // each whisper segment takes the speaker it overlaps most
  return segments.map((s2) => {
    let bestT: Turn | null = null, bestOv = 0.2;
    for (const t of turns) {
      const ov = Math.min(s2.t1, t.end) - Math.max(s2.t0, t.start);
      if (ov > bestOv) { bestOv = ov; bestT = t; }
    }
    const who = bestT?.cluster !== undefined ? label.get(bestT.cluster!) : undefined;
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
