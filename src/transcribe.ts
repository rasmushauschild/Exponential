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
const EMB_MODEL = 'onnx-community/wespeaker-voxceleb-resnet34-LM'; // diarization-grade (pyannote 3.1 uses this family); the Xenova mirror is gated, onnx-community is public

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
    const { AutoProcessor, AutoModel } = await import('@huggingface/transformers');
    const processor = await AutoProcessor.from_pretrained(EMB_MODEL);
    const model = await AutoModel.from_pretrained(EMB_MODEL, { dtype: 'fp32' } as never);
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

/** Enrollment sample → a robust voice print: the MEAN embedding over 3s slices. */
export async function voiceEmbedding(blob: Blob): Promise<number[]> {
  const audio = await decodeTo16k(blob);
  const SR = 16000, SLICE = 3 * SR;
  const embs: number[][] = [];
  for (let off = 0; off + SR <= audio.length && embs.length < 8; off += SLICE) {
    const e = await embed(audio.subarray(off, Math.min(audio.length, off + SLICE))).catch(() => null);
    if (e) embs.push(e);
  }
  if (!embs.length) return embed(audio);
  return l2(embs[0].map((_, i) => embs.reduce((a, v) => a + v[i], 0) / embs.length));
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
  const WIN = 10 * SR, HOP = 8 * SR; // 10s is the model's native scale AND it caps at 3 concurrent speakers per window — 30s windows collapsed 4-person rooms
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
    const sorted = [...byGroup.get(k)!].sort((a, b) => (b.end - b.start) - (a.end - a.start)).slice(0, 3);
    const embs: number[][] = [];
    for (const t of sorted) {
      const mid = (t.start + t.end) / 2, half = Math.min(3, (t.end - t.start) / 2);
      const a = audio.subarray(Math.max(0, Math.floor((mid - half) * SR)), Math.floor((mid + half) * SR));
      if (a.length >= SR * 0.8) { const e = await embed(a).catch(() => null); if (e) embs.push(e); }
    }
    const e = embs.length ? l2(embs[0].map((_, i) => embs.reduce((a2, v) => a2 + v[i], 0) / embs.length)) : null;
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

  // With enrolled voice prints, identification is PER TURN (closed-set): each turn is
  // scored against every teammate's print. Cluster identity is only smoothing — the
  // segmentation model tops out at 3 concurrent speakers per window, so clusters are
  // unreliable with a full room, but individual turns are clean slices of one voice.
  const turnLabel = new Map<Turn, string>();
  if (enrolled.length) {
    const prints = enrolled.map((en) => ({ id: en.id, e: l2(en.embedding) }));
    const turnEmb = new Map<Turn, number[] | null>();
    for (const t of turns) {
      if (t.end - t.start < 0.8) { turnEmb.set(t, null); continue; }
      const mid = (t.start + t.end) / 2, half = Math.min(1.5, (t.end - t.start) / 2);
      const a = audio.subarray(Math.max(0, Math.floor((mid - half) * SR)), Math.floor((mid + half) * SR));
      turnEmb.set(t, await embed(a).catch(() => null));
    }
    for (const t of turns) {
      const e = turnEmb.get(t);
      if (!e) continue;
      const sims = prints.map((p2) => ({ id: p2.id, sim: cos(e, p2.e) })).sort((a, b) => b.sim - a.sim);
      if (sims[0] && sims[0].sim >= 0.4 && (sims[0].sim - (sims[1]?.sim ?? 0) >= 0.05 || sims[0].sim >= 0.7)) {
        turnLabel.set(t, sims[0].id);
      }
    }
    // smoothing: unidentified turns inherit the majority label of their window-local group
    for (const group of byGroup.values()) {
      const votes = new Map<string, number>();
      for (const t of group) { const l = turnLabel.get(t); if (l) votes.set(l, (votes.get(l) ?? 0) + (t.end - t.start)); }
      let best = '', bw = 0;
      for (const [l, w] of votes) if (w > bw) { best = l; bw = w; }
      if (best) for (const t of group) if (!turnLabel.has(t)) turnLabel.set(t, best);
    }
    // exclusivity: two overlapping turns can't be the same person — the shorter goes anonymous
    for (const a of turns) for (const b of turns) {
      if (a === b) continue;
      const la = turnLabel.get(a), lb = turnLabel.get(b);
      if (!la || la !== lb) continue;
      if (Math.min(a.end, b.end) - Math.max(a.start, b.start) > 0.5) {
        turnLabel.delete((a.end - a.start) < (b.end - b.start) ? a : b);
      }
    }
  }

  // anything still unlabeled falls back to the stitch clusters as Speaker N
  const label = new Map<number, string>();
  let anon = 0;
  for (const k of orderedKeys) {
    const c = clusterOf.get(k)!;
    if (!label.has(c)) label.set(c, `Speaker ${++anon}`);
  }

  // each whisper segment takes the speaker whose turns overlap it most (per-turn
  // identities first; stitch-cluster Speaker N covers the rest)
  return segments.map((s2) => {
    const share = new Map<string, number>();
    for (const t of turns) {
      const ov = Math.min(s2.t1, t.end) - Math.max(s2.t0, t.start);
      if (ov <= 0.15) continue;
      const who = turnLabel.get(t) ?? label.get(clusterOf.get(key(t))!)!;
      share.set(who, (share.get(who) ?? 0) + ov);
    }
    let best = '', bestOv = 0.2;
    for (const [w, ov] of share) if (ov > bestOv) { best = w; bestOv = ov; }
    return best ? { ...s2, who: best } : s2;
  });
}

/** Map already-grouped speaker labels (e.g. the cloud's "Speaker A/B/C") to enrolled
 *  teammates: embed each group's longest stretches, match with the margin rule, keep
 *  each person to one group. Unmatched groups keep their label. */
export async function nameSpeakerGroups(blob: Blob, segments: Segment[], enrolled: Enrolled[]): Promise<Segment[]> {
  const SR = 16000;
  const audio = await decodeTo16k(blob);
  const groups = new Map<string, Segment[]>();
  for (const s of segments) { if (!s.who) continue; if (!groups.has(s.who)) groups.set(s.who, []); groups.get(s.who)!.push(s); }
  const prints = enrolled.map((en) => ({ id: en.id, e: l2(en.embedding) }));
  const scored: { who: string; id: string; sim: number; margin: number }[] = [];
  for (const [who, segs] of groups) {
    const longest = [...segs].sort((a, b) => (b.t1 - b.t0) - (a.t1 - a.t0)).slice(0, 3);
    const embs: number[][] = [];
    for (const g of longest) {
      const mid = (g.t0 + g.t1) / 2, half = Math.min(3, (g.t1 - g.t0) / 2);
      const a = audio.subarray(Math.max(0, Math.floor((mid - half) * SR)), Math.floor((mid + half) * SR));
      if (a.length >= SR * 0.8) { const e = await embed(a).catch(() => null); if (e) embs.push(e); }
    }
    if (!embs.length) continue;
    const e = l2(embs[0].map((_, i2) => embs.reduce((a2, v) => a2 + v[i2], 0) / embs.length));
    const sims = prints.map((p2) => ({ id: p2.id, sim: cos(e, p2.e) })).sort((a, b) => b.sim - a.sim);
    if (sims[0] && sims[0].sim >= 0.4) scored.push({ who, id: sims[0].id, sim: sims[0].sim, margin: sims[0].sim - (sims[1]?.sim ?? 0) });
  }
  scored.sort((a, b) => b.sim - a.sim);
  const rename = new Map<string, string>();
  const used = new Set<string>();
  for (const m of scored) {
    if (used.has(m.id) || rename.has(m.who)) continue;
    if (m.margin < 0.05 && m.sim < 0.7) continue;
    rename.set(m.who, m.id);
    used.add(m.id);
  }
  return segments.map((s) => (s.who && rename.has(s.who) ? { ...s, who: rename.get(s.who)! } : s));
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
