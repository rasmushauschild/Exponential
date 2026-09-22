/**
 * Meeting recording: microphone always; system audio (the other side of a call) mixed in
 * when the platform gives us a loopback stream (Electron's display-media handler — the OS
 * may ask for screen-recording permission once). One WebAudio graph feeds a single
 * MediaRecorder (opus/webm, 48 kbps — speech). Chunks stream to disk through the main
 * process every 5 s in Electron so an hour-long meeting never sits in renderer memory;
 * the browser preview keeps them in memory instead.
 */

export interface RecordingSession {
  meetingId: string;
  startedAt: Date;
  systemAudio: boolean;
  /** 0..1 level for the meter, read per frame. */
  level: () => number;
  state: () => 'recording' | 'paused';
  /** seconds actually recorded (pauses excluded) */
  activeSecs: () => number;
  pause: () => void;
  resume: () => void;
  stop: () => Promise<{ blob: Blob; durationSecs: number }>;
}

let current: RecordingSession | null = null;
export const activeRecording = () => current;

export async function startRecording(meetingId: string): Promise<RecordingSession> {
  if (current) throw new Error('Already recording');
  const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });

  let system: MediaStream | null = null;
  try {
    // Electron routes this through setDisplayMediaRequestHandler with audio:'loopback'.
    const disp = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    disp.getVideoTracks().forEach((t) => t.stop());
    if (disp.getAudioTracks().length) system = new MediaStream(disp.getAudioTracks());
  } catch { /* no loopback here (denied, or platform can't) — mic only */ }

  const ctx = new AudioContext({ sampleRate: 48000 });
  const dest = ctx.createMediaStreamDestination();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  const micSrc = ctx.createMediaStreamSource(mic);
  micSrc.connect(dest);
  micSrc.connect(analyser);
  if (system) {
    const sysSrc = ctx.createMediaStreamSource(system);
    const g = ctx.createGain();
    g.gain.value = 0.9;
    sysSrc.connect(g); g.connect(dest); g.connect(analyser);
  }

  const chunks: Blob[] = [];
  const toDisk = !!window.exponential?.meetingAppend;
  const rec = new MediaRecorder(dest.stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 48_000 });
  // appends chain so stop() can wait for the final chunk to reach disk before reading back
  let flushed: Promise<void> = Promise.resolve();
  rec.ondataavailable = (e) => {
    if (!e.data.size) return;
    if (toDisk) {
      flushed = flushed.then(async () => {
        try { await window.exponential!.meetingAppend!(meetingId, await e.data.arrayBuffer()); }
        catch { chunks.push(e.data); }
      });
      return;
    }
    chunks.push(e.data);
  };
  rec.start(5000);
  const startedAt = new Date();
  let paused = false;
  let pausedTotal = 0;
  let pausedAt = 0;

  const buf = new Uint8Array(analyser.fftSize);
  const level = () => {
    analyser.getByteTimeDomainData(buf);
    let peak = 0;
    for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128));
    return Math.min(1, peak / 110);
  };

  const session: RecordingSession = {
    meetingId,
    startedAt,
    systemAudio: !!system,
    level,
    state: () => (paused ? 'paused' : 'recording'),
    activeSecs: () => Math.max(0, (Date.now() - +startedAt - pausedTotal - (paused ? Date.now() - pausedAt : 0)) / 1000),
    pause: () => { if (!paused && rec.state === 'recording') { rec.pause(); paused = true; pausedAt = Date.now(); } },
    resume: () => { if (paused) { rec.resume(); paused = false; pausedTotal += Date.now() - pausedAt; } },
    stop: () => new Promise((resolve, reject) => {
      rec.onstop = async () => {
        try {
          mic.getTracks().forEach((t) => t.stop());
          system?.getTracks().forEach((t) => t.stop());
          await ctx.close().catch(() => {});
          await flushed;
          let blob: Blob;
          if (toDisk && !chunks.length) {
            const data = await window.exponential!.meetingRead!(meetingId);
            blob = new Blob([data], { type: 'audio/webm' });
          } else {
            blob = new Blob(chunks, { type: 'audio/webm' });
          }
          current = null;
          resolve({ blob, durationSecs: Math.round(session.activeSecs()) });
        } catch (e) { current = null; reject(e); }
      };
      rec.stop(); // flushes the final chunk through ondataavailable first
    }),
  };
  current = session;
  return session;
}
