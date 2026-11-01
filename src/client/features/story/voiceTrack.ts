import { wavChunk } from '@/engine/wav'
import { LINE_GAP, LINE_LEAD, voicesSeconds } from './animatic'

/**
 * A dialogue shot's voice track for LTX's audio to follow (A2V): the shot's ElevenLabs lines placed the way Assemble
 * lays them under a shot — a short lead-in, a gap between lines, room after the last — and silence to the shot's end.
 * The clip is made to it: the exact words, in the right voice, lip-synced, and it lasts the whole shot (an LTX clip
 * from audio is no longer than the audio).
 */

export interface VoiceTrackLine {
  /** The voiced line (an ElevenLabs audio asset). */
  assetId: string
  seconds: number
}

export interface VoiceTrackPlan {
  /** The track's length: the shot's, or the whole seconds its lines need. */
  seconds: number
  /** Where each line starts, in seconds from the start. */
  placements: { assetId: string; at: number }[]
  /** Same lines, same length: the same track (what a made track is cached by). */
  key: string
  /** The lines fit in one clip of `maxSeconds`. */
  fits: boolean
}

export const voiceTrackKey = (lines: readonly Pick<VoiceTrackLine, 'assetId'>[], seconds: number) => `${lines.map((l) => l.assetId).join('+')}@${seconds}`

export function planVoiceTrack(lines: readonly VoiceTrackLine[], shotSeconds: number, maxSeconds = 10): VoiceTrackPlan | undefined {
  if (!lines.length) return undefined
  const need = voicesSeconds(lines.map((l) => l.seconds))
  const seconds = Math.min(maxSeconds, Math.max(shotSeconds, Math.ceil(need - 1e-9)))
  let at = LINE_LEAD
  const placements = lines.map((l) => {
    const placed = { assetId: l.assetId, at: Math.round(at * 1000) / 1000 }
    at += l.seconds + LINE_GAP
    return placed
  })
  return { seconds, placements, key: voiceTrackKey(lines, seconds), fits: need <= maxSeconds + 1e-9 }
}

/**
 * Silence after the track's length: LTX renders a frame past the whole seconds (1 + 8k frames: 3 s at 24 fps is 73),
 * and the audio it follows must not run out before the picture does.
 */
export const VOICE_TRACK_PAD = 0.25

/** Mixes the plan's lines into one 48 kHz stereo buffer, VOICE_TRACK_PAD longer than the plan (browser: OfflineAudioContext). */
export async function renderVoiceTrack(
  plan: VoiceTrackPlan,
  decode: (assetId: string) => Promise<AudioBuffer | undefined> = (id) => wavChunk(id, 0),
  sampleRate = 48_000,
): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: Math.round((plan.seconds + VOICE_TRACK_PAD) * sampleRate), sampleRate })
  for (const p of plan.placements) {
    const buffer = await decode(p.assetId)
    if (!buffer) throw new Error('A voiced line has no audio yet')
    const node = ctx.createBufferSource()
    node.buffer = buffer
    node.connect(ctx.destination)
    // Cut at the track's end: a line never runs past the shot.
    node.start(p.at, 0, Math.max(0, Math.min(buffer.duration, plan.seconds - p.at)))
  }
  return ctx.startRendering()
}

/** 16-bit PCM WAV: what every audio loader takes (ComfyUI's LoadAudio included). */
export function pcm16Wav(buffer: Pick<AudioBuffer, 'numberOfChannels' | 'length' | 'sampleRate' | 'getChannelData'>): Blob {
  const channels = buffer.numberOfChannels
  const frames = buffer.length
  const dataSize = frames * channels * 2
  const out = new ArrayBuffer(44 + dataSize)
  const view = new DataView(out)
  const write = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  write(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  write(8, 'WAVE')
  write(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, channels, true)
  view.setUint32(24, buffer.sampleRate, true)
  view.setUint32(28, buffer.sampleRate * channels * 2, true)
  view.setUint16(32, channels * 2, true)
  view.setUint16(34, 16, true)
  write(36, 'data')
  view.setUint32(40, dataSize, true)
  const data = new Int16Array(out, 44)
  const chans = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c))
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const v = Math.max(-1, Math.min(1, chans[c]![i]!))
      data[i * channels + c] = v < 0 ? Math.round(v * 32768) : Math.round(v * 32767)
    }
  }
  return new Blob([out], { type: 'audio/wav' })
}
