import { describe, expect, it } from 'vitest'
import { detectBeats } from './beats'

/** Clicks every `period` seconds (accent every 4th) over low noise. */
function clickTrack(bpm: number, seconds: number, rate = 11025): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate))
  let seed = 7
  for (let i = 0; i < out.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    out[i] = ((seed / 0x7fffffff) * 2 - 1) * 0.01
  }
  const period = 60 / bpm
  for (let b = 0; b * period < seconds; b++) {
    const start = Math.round((0.1 + b * period) * rate)
    const amp = b % 4 === 0 ? 0.9 : 0.5
    for (let j = 0; j < rate * 0.03 && start + j < out.length; j++) out[start + j]! += amp * Math.exp(-j / (rate * 0.008)) * Math.sin(j * 0.6)
  }
  return out
}

describe('detectBeats', () => {
  it.each([90, 120, 140])('finds the tempo of a %i BPM click track', (bpm) => {
    const res = detectBeats(clickTrack(bpm, 20), 11025)
    expect(Math.abs(res.bpm - bpm)).toBeLessThan(3)
    const period = 60 / bpm
    const gaps = res.beats.slice(1).map((b, i) => b - res.beats[i]!)
    const median = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)]!
    expect(Math.abs(median - period)).toBeLessThan(0.03)
    // Beats sit on the clicks (first click at 0.1 s).
    const phase = ((((res.beats[0]! - 0.1) / period) % 1) + 1) % 1
    expect(Math.min(phase, 1 - phase)).toBeLessThan(0.1)
    expect(res.downbeats.length).toBeGreaterThan(2)
  })

  it('returns nothing for very short audio', () => {
    expect(detectBeats(new Float32Array(1000), 11025).beats).toEqual([])
  })
})
