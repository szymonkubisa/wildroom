/**
 * Beat tracking for music clips (FCP-style beat markers): an energy-flux onset envelope, a tempo from its
 * autocorrelation (60–190 BPM, gently biased towards ~120), then beats following that tempo, each snapped to the
 * strongest nearby onset. Pure — the caller decodes audio to mono floats.
 */

export interface BeatResult {
  bpm: number
  /** Beat times in seconds from the start of the audio. */
  beats: number[]
  /** Every 4th beat, starting at the strongest phase (bar downbeats, approximate). */
  downbeats: number[]
}

const FRAME = 1024
const HOP = 128

export function onsetEnvelope(samples: Float32Array, rate: number): { env: Float32Array; envRate: number } {
  const count = Math.max(0, Math.floor((samples.length - FRAME) / HOP) + 1)
  const energy = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    let sum = 0
    const off = i * HOP
    for (let j = 0; j < FRAME; j++) {
      const s = samples[off + j]!
      sum += s * s
    }
    energy[i] = Math.log1p(1000 * (sum / FRAME))
  }
  const flux = new Float32Array(count)
  for (let i = 1; i < count; i++) flux[i] = Math.max(0, energy[i]! - energy[i - 1]!)
  // Remove the slowly varying part so loud passages do not dominate.
  const envRate = rate / HOP
  const win = Math.max(1, Math.round(envRate * 0.25))
  const env = new Float32Array(count)
  let acc = 0
  for (let i = 0; i < count; i++) {
    acc += flux[i]!
    if (i >= 2 * win + 1) acc -= flux[i - 2 * win - 1]!
    const lo = Math.max(0, i - 2 * win)
    const mean = acc / (i - lo + 1)
    const c = i - win
    if (c >= 0) env[c] = Math.max(0, flux[c]! - mean)
  }
  return { env, envRate }
}

function estimateLag(raw: Float32Array, envRate: number): number {
  // Spread each onset over ±2 frames so tempos between integer lags still correlate.
  const env = new Float32Array(raw.length)
  for (let i = 0; i < raw.length; i++) {
    let m = 0
    for (let k = -2; k <= 2; k++) m = Math.max(m, (raw[i + k] ?? 0) * (1 - Math.abs(k) * 0.2))
    env[i] = m
  }
  const minLag = Math.max(2, Math.floor((60 / 190) * envRate))
  const maxLag = Math.min(env.length - 1, Math.ceil((60 / 60) * envRate))
  const scores = new Float64Array(maxLag + 2)
  let best = minLag
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0
    for (let i = lag; i < env.length; i++) sum += env[i]! * env[i - lag]!
    const bpm = (60 * envRate) / lag
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2)
    scores[lag] = (sum / (env.length - lag)) * prior
    if (scores[lag]! > scores[best]!) best = lag
  }
  // Fractional lag from a parabola through the peak and its neighbours (tempos rarely fall on whole frames).
  const a = scores[best - 1] ?? 0
  const b = scores[best]!
  const c = scores[best + 1] ?? 0
  const denom = a - 2 * b + c
  const shift = best > minLag && best < maxLag && denom < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom)) : 0
  return best + shift
}

export function detectBeats(samples: Float32Array, rate: number): BeatResult {
  const { env, envRate } = onsetEnvelope(samples, rate)
  if (env.length < envRate * 2) return { bpm: 0, beats: [], downbeats: [] }
  const lag = estimateLag(env, envRate)
  // Phase: the offset whose beat grid collects the most onset energy.
  const peakNear = (x: number) => {
    const i = Math.round(x)
    return Math.max(env[i] ?? 0, env[i - 1] ?? 0, env[i + 1] ?? 0)
  }
  let phase = 0
  let phaseScore = -Infinity
  for (let p = 0; p < Math.ceil(lag); p++) {
    let s = 0
    for (let x = p; x < env.length; x += lag) s += peakNear(x)
    if (s > phaseScore) {
      phaseScore = s
      phase = p
    }
  }
  const tol = Math.max(1, Math.round(lag * 0.1))
  const frames: number[] = []
  for (let expected = phase; expected < env.length; ) {
    const center = Math.round(expected)
    let pos = Math.min(env.length - 1, center)
    for (let k = Math.max(0, center - tol); k <= Math.min(env.length - 1, center + tol); k++) if (env[k]! > env[pos]!) pos = k
    frames.push(pos)
    // Follow the detected onset only when there is one; otherwise keep the tempo grid.
    expected = (env[pos]! > 0 ? pos : expected) + lag
  }
  // The flux peaks when the onset enters the analysis window, i.e. at the window's end.
  const beats = frames.map((f) => Math.round(((f * HOP + FRAME) / rate) * 1000) / 1000)
  // Downbeats: the 4-beat phase with the most energy.
  let bar = 0
  let barScore = -Infinity
  for (let p = 0; p < 4; p++) {
    let s = 0
    for (let i = p; i < frames.length; i += 4) s += env[frames[i]!]!
    if (s > barScore) {
      barScore = s
      bar = p
    }
  }
  const intervals = beats.slice(1).map((b, i) => b - beats[i]!).sort((a, b) => a - b)
  const median = intervals[Math.floor(intervals.length / 2)] ?? lag / envRate
  return {
    bpm: Math.round((60 / median) * 10) / 10,
    beats,
    downbeats: beats.filter((_, i) => i % 4 === bar),
  }
}
