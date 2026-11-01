import { afterEach, describe, expect, it, vi } from 'vitest'
import { LiveAudio } from './audioEngine'
import type { PlaybackClock } from './clock'
import { type AudioSegment, type Scene, emptyScene } from './scene'

function node() {
  const n = { gain: { value: 1 }, fftSize: 0, connect: () => n, disconnect: () => {}, getFloatTimeDomainData: () => {} }
  return n
}

/** Enough of an AudioContext for the graph to be built; the clock stays stopped, so nothing is fetched. */
function fakeClock(): PlaybackClock {
  const ctx = { destination: node(), createGain: node, createChannelSplitter: node, createAnalyser: node }
  return { ctx, running: false, rate: 0, now: () => 0 } as unknown as PlaybackClock
}

function scene(gainDb = 0, editPoints = [0, 240]): Scene {
  const voice: AudioSegment = {
    clipId: 'c1',
    assetId: 'voice',
    start: 0,
    end: 240,
    sourceStart: 0,
    speed: 1,
    role: 'dialogue',
    audio: { enabled: true, role: 'dialogue', gainDb, pan: 0, fadeIn: 0, fadeOut: 0 },
    transitions: [],
  }
  return { ...emptyScene(), duration: 240, audio: [voice], editPoints }
}

describe('live audio', () => {
  afterEach(() => vi.restoreAllMocks())

  it('keeps playing through a new scene with the same sound, and restarts when the sound changed', () => {
    const live = new LiveAudio(fakeClock(), { masterDb: 0, roles: {} })
    live.setScene(scene())
    live.start()
    const start = vi.spyOn(live, 'start')

    // A picture-only edit (a title added on a lane) builds a new scene with the same sound.
    live.setScene(scene(0, [0, 48, 240]))
    expect(start).not.toHaveBeenCalled()

    live.setScene(scene(-6))
    expect(start).toHaveBeenCalledOnce()
    live.stop()
  })
})
