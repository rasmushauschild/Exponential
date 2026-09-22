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
  | { phase: 'run'; pct: number };

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
