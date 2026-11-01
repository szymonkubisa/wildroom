import { describe, expect, it } from 'vitest'
import { LINE_GAP, LINE_LEAD, LINE_TAIL } from './animatic'
import { pcm16Wav, planVoiceTrack, voiceTrackKey } from './voiceTrack'

describe('voice track', () => {
  it('places a line after the lead-in and pads to the shot', () => {
    expect(planVoiceTrack([{ assetId: 'a', seconds: 2 }], 3)).toEqual({ seconds: 3, placements: [{ assetId: 'a', at: LINE_LEAD }], key: 'a@3', fits: true })
  })

  it('places lines one after another and grows the track to the whole seconds they need', () => {
    const plan = planVoiceTrack([{ assetId: 'a', seconds: 2.4 }, { assetId: 'b', seconds: 1.5 }], 3)!
    expect(plan.placements).toEqual([{ assetId: 'a', at: LINE_LEAD }, { assetId: 'b', at: Math.round((LINE_LEAD + 2.4 + LINE_GAP) * 1000) / 1000 }])
    expect(plan.seconds).toBe(Math.ceil(LINE_LEAD + 2.4 + LINE_GAP + 1.5 + LINE_TAIL))
    expect(plan.key).toBe(voiceTrackKey([{ assetId: 'a' }, { assetId: 'b' }], plan.seconds))
  })

  it('says when the lines need more than one clip', () => {
    const plan = planVoiceTrack([{ assetId: 'a', seconds: 9.8 }], 4)!
    expect(plan).toMatchObject({ seconds: 10, fits: false })
    expect(planVoiceTrack([], 4)).toBeUndefined()
  })

  it('writes 16-bit PCM WAV', async () => {
    const samples = [new Float32Array([0, 1, -1, 0.5]), new Float32Array([0, -0.5, 2, -2])]
    const wav = pcm16Wav({ numberOfChannels: 2, length: 4, sampleRate: 48_000, getChannelData: (c: number) => samples[c]! })
    const bytes = await wav.arrayBuffer()
    const view = new DataView(bytes)
    const text = (o: number) => String.fromCharCode(...new Uint8Array(bytes, o, 4))
    expect([text(0), text(8), text(12), text(36)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data'])
    expect([view.getUint16(20, true), view.getUint16(22, true), view.getUint32(24, true), view.getUint16(34, true), view.getUint32(40, true)]).toEqual([1, 2, 48_000, 16, 16])
    expect([...new Int16Array(bytes, 44)]).toEqual([0, 0, 32767, -16384, -32768, 32767, 16384, -32768])
  })
})
