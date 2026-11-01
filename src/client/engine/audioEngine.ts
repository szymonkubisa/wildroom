import { type MixSettings, defaultMix } from '@shared/types/project-doc'
import type { PlaybackClock } from './clock'
import { type AudioSegment, type Scene, dbToGain, segmentGain } from './scene'
import { CHUNK_SECONDS, wavChunk } from './wav'


/** Bus-level part of the mix (clip-level normalisation and ducking live in the scene). */
export type MixerState = Pick<MixSettings, 'masterDb' | 'roles'>

export function defaultMixer(): MixerState {
  return defaultMix()
}

/**
 * Role buses → master. Used by both live playback and the offline export so the mix is identical.
 */
export class MixGraph {
  readonly master: GainNode
  private readonly buses = new Map<string, GainNode>()
  /** Post-fader taps per role bus (live playback only — the mixer's channel meters). */
  private readonly meters = new Map<string, AnalyserNode>()
  private readonly meterData = new Float32Array(512)

  constructor(
    private readonly ctx: BaseAudioContext,
    destination: AudioNode,
    private mixer: MixerState,
    private readonly onlyRole?: string,
    private readonly metered = false,
  ) {
    this.master = ctx.createGain()
    this.master.connect(destination)
    this.apply(mixer)
  }

  bus(role: string): GainNode {
    const base = role.split('.')[0] ?? role
    let bus = this.buses.get(base)
    if (!bus) {
      bus = this.ctx.createGain()
      bus.connect(this.master)
      this.buses.set(base, bus)
      if (this.metered) {
        const meter = this.ctx.createAnalyser()
        meter.fftSize = 512
        bus.connect(meter)
        this.meters.set(base, meter)
      }
      this.applyBus(base, bus)
    }
    return bus
  }

  /** Post-fader peak of a role bus in dBFS (−Infinity when silent or not metered). */
  busLevel(role: string): number {
    const meter = this.meters.get(role)
    if (!meter) return -Infinity
    meter.getFloatTimeDomainData(this.meterData)
    let peak = 0
    for (const v of this.meterData) if (Math.abs(v) > peak) peak = Math.abs(v)
    return peak > 0 ? 20 * Math.log10(peak) : -Infinity
  }

  apply(mixer: MixerState) {
    this.mixer = mixer
    this.master.gain.value = dbToGain(mixer.masterDb)
    for (const [role, bus] of this.buses) this.applyBus(role, bus)
  }

  private applyBus(role: string, bus: GainNode) {
    const soloed = Object.values(this.mixer.roles).some((r) => r.solo)
    const r = this.mixer.roles[role]
    let gain = r ? dbToGain(r.gainDb) : 1
    if (r?.mute || (soloed && !r?.solo)) gain = 0
    if (this.onlyRole && role !== this.onlyRole) gain = 0
    bus.gain.value = gain
  }
}

/** Gain → pan → bus chain for one segment with its full automation curve over [fromFrame, toFrame). */
function createChain(
  ctx: BaseAudioContext,
  seg: AudioSegment,
  graph: MixGraph,
  fps: number,
  fromFrame: number,
  toFrame: number,
  startTime: number,
): GainNode {
  const gain = ctx.createGain()
  const pan = ctx.createStereoPanner()
  pan.pan.value = Math.max(-1, Math.min(1, seg.audio.pan))
  gain.connect(pan).connect(graph.bus(seg.role))
  const duration = (toFrame - fromFrame) / fps
  const steps = Math.max(2, Math.min(24_000, Math.ceil(duration * 100)))
  const curve = new Float32Array(steps)
  for (let i = 0; i < steps; i++) {
    const frame = fromFrame + (i / (steps - 1)) * (toFrame - fromFrame)
    curve[i] = segmentGain(seg, Math.min(frame, toFrame - 1e-3))
  }
  gain.gain.setValueAtTime(curve[0]!, Math.max(0, startTime))
  if (duration > 0.02) gain.gain.setValueCurveAtTime(curve, Math.max(0, startTime), duration)
  return gain
}

/** Source-time window [a, b) of a segment that falls inside chunk `index`. */
function chunkWindow(seg: AudioSegment, fps: number, index: number, bufferDuration: number) {
  const segSrcEnd = seg.sourceStart + ((seg.end - seg.start) / fps) * seg.speed
  const c0 = index * CHUNK_SECONDS
  const a = Math.max(c0, seg.sourceStart)
  const b = Math.min(c0 + bufferDuration, segSrcEnd)
  return { c0, a, b }
}

/** Everything in a scene that changes what is heard (clips, timing, levels, fades, normalisation, ducking). */
export function audioSignature(scene: Scene): string {
  return JSON.stringify([scene.fps, scene.audio])
}

/** Live playback: streams WAV chunks just ahead of the clock. */
export class LiveAudio {
  private graph: MixGraph
  private scene: Scene | undefined
  /** Signature of the scene the scheduled sound was built from. */
  private playingSignature = ''
  private readonly scheduled = new Map<string, AudioBufferSourceNode | null>()
  private readonly chains = new Map<string, GainNode>()
  private timer: ReturnType<typeof setInterval> | undefined
  private session = 0
  private readonly analysers: AnalyserNode[]
  private readonly meterData = new Float32Array(1024)

  constructor(
    private readonly clock: PlaybackClock,
    mixer: MixerState,
  ) {
    const ctx = clock.ctx
    const out = ctx.createGain()
    out.connect(ctx.destination)
    const splitter = ctx.createChannelSplitter(2)
    out.connect(splitter)
    this.analysers = [0, 1].map((ch) => {
      const a = ctx.createAnalyser()
      a.fftSize = 1024
      splitter.connect(a, ch)
      return a
    })
    this.graph = new MixGraph(ctx, out, mixer, undefined, true)
  }

  setScene(scene: Scene) {
    this.scene = scene
    if (this.timer === undefined) return
    // Every doc edit or asset update makes a new Scene: restart (an audible gap) only when the sound itself changed.
    // Clip levels are baked into the scheduled gain curves, so a volume or fade change still restarts to be heard.
    if (audioSignature(scene) === this.playingSignature) return
    this.stop()
    this.start()
  }

  setMixer(mixer: MixerState) {
    this.graph.apply(mixer)
  }

  start() {
    this.stopNodes()
    this.session++
    this.playingSignature = this.scene ? audioSignature(this.scene) : ''
    this.pump()
    this.timer = setInterval(() => this.pump(), 150)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.stopNodes()
    this.session++
  }

  /** Post-fader peak of one role bus in dBFS (mixer channel meters). */
  roleLevel(role: string): number {
    return this.graph.busLevel(role)
  }

  /** Peak level per channel in dBFS (for meters). */
  levels(): [number, number] {
    return this.analysers.map((a) => {
      a.getFloatTimeDomainData(this.meterData)
      let peak = 0
      for (const v of this.meterData) if (Math.abs(v) > peak) peak = Math.abs(v)
      return peak > 0 ? 20 * Math.log10(peak) : -Infinity
    }) as [number, number]
  }

  private stopNodes() {
    for (const node of this.scheduled.values()) {
      try {
        node?.stop()
      } catch {
        // not started
      }
      node?.disconnect()
    }
    for (const chain of this.chains.values()) chain.disconnect()
    this.scheduled.clear()
    this.chains.clear()
  }

  private pump() {
    const scene = this.scene
    if (!scene || !this.clock.running || this.clock.rate !== 1) return
    const fps = scene.fps
    const now = this.clock.now()
    const horizon = now + 2.5
    const session = this.session
    for (const seg of scene.audio) {
      if (!seg.audio.enabled) continue
      const s0 = seg.start / fps
      const s1 = seg.end / fps
      if (s1 <= now || s0 >= horizon) continue
      const src0 = seg.sourceStart + (Math.max(now, s0) - s0) * seg.speed
      const src1 = seg.sourceStart + (Math.min(horizon, s1) - s0) * seg.speed
      for (let index = Math.floor(src0 / CHUNK_SECONDS); index * CHUNK_SECONDS < src1; index++) {
        const key = `${seg.clipId}:${index}`
        if (this.scheduled.has(key)) continue
        this.scheduled.set(key, null) // loading
        void wavChunk(seg.assetId, index)
          .then((buffer) => {
            if (session !== this.session || !buffer) return
            this.scheduleChunk(scene, seg, index, buffer, key)
          })
          .catch(() => this.scheduled.delete(key))
      }
    }
  }

  private scheduleChunk(scene: Scene, seg: AudioSegment, index: number, buffer: AudioBuffer, key: string) {
    const ctx = this.clock.ctx
    const fps = scene.fps
    const { c0, a: a0, b } = chunkWindow(seg, fps, index, buffer.duration)
    let a = a0
    if (b <= a) return
    const s0 = seg.start / fps
    let when = this.clock.contextTimeFor(s0 + (a - seg.sourceStart) / seg.speed)
    const earliest = ctx.currentTime + 0.005
    if (when < earliest) {
      a += (earliest - when) * seg.speed
      when = earliest
      if (b <= a) return
    }
    const node = ctx.createBufferSource()
    node.buffer = buffer
    node.playbackRate.value = seg.speed
    node.connect(this.chain(scene, seg))
    node.start(when, a - c0, b - a)
    this.scheduled.set(key, node)
  }

  private chain(scene: Scene, seg: AudioSegment): GainNode {
    let chain = this.chains.get(seg.clipId)
    if (!chain) {
      const fps = scene.fps
      const fromFrame = Math.max(seg.start, this.clock.now() * fps)
      chain = createChain(this.clock.ctx, seg, this.graph, fps, fromFrame, seg.end, this.clock.contextTimeFor(fromFrame / fps))
      this.chains.set(seg.clipId, chain)
    }
    return chain
  }
}

/**
 * Offline mixdown of [startFrame, endFrame) — same segments, gains and buses as playback.
 * `onlyRole` renders a single role stem.
 */
export async function renderMixdown(
  scene: Scene,
  startFrame: number,
  endFrame: number,
  mixer: MixerState,
  opts: { onlyRole?: string; sampleRate?: number } = {},
): Promise<AudioBuffer> {
  const sampleRate = opts.sampleRate ?? 48_000
  const fps = scene.fps
  const length = Math.max(1, Math.round(((endFrame - startFrame) / fps) * sampleRate))
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length, sampleRate })
  const graph = new MixGraph(ctx, ctx.destination, mixer, opts.onlyRole)
  const origin = startFrame / fps
  for (const seg of scene.audio) {
    if (!seg.audio.enabled) continue
    const from = Math.max(seg.start, startFrame)
    const to = Math.min(seg.end, endFrame)
    if (to <= from) continue
    const chain = createChain(ctx, seg, graph, fps, from, to, from / fps - origin)
    const s0 = seg.start / fps
    const src0 = seg.sourceStart + (from / fps - s0) * seg.speed
    const src1 = seg.sourceStart + (to / fps - s0) * seg.speed
    for (let index = Math.floor(src0 / CHUNK_SECONDS); index * CHUNK_SECONDS < src1; index++) {
      const buffer = await wavChunk(seg.assetId, index)
      if (!buffer) break
      const c0 = index * CHUNK_SECONDS
      const a = Math.max(c0, src0)
      const b = Math.min(c0 + buffer.duration, src1)
      if (b <= a) continue
      const node = ctx.createBufferSource()
      node.buffer = buffer
      node.playbackRate.value = seg.speed
      node.connect(chain)
      node.start(s0 + (a - seg.sourceStart) / seg.speed - origin, a - c0, b - a)
    }
  }
  return ctx.startRendering()
}

/** 32-bit float WAV (keeps headroom for the server-side loudness pass). */
export function audioBufferToWav(buffer: AudioBuffer): Blob {
  const channels = buffer.numberOfChannels
  const frames = buffer.length
  const bytesPerSample = 4
  const dataSize = frames * channels * bytesPerSample
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
  view.setUint16(20, 3, true) // IEEE float
  view.setUint16(22, channels, true)
  view.setUint32(24, buffer.sampleRate, true)
  view.setUint32(28, buffer.sampleRate * channels * bytesPerSample, true)
  view.setUint16(32, channels * bytesPerSample, true)
  view.setUint16(34, 32, true)
  write(36, 'data')
  view.setUint32(40, dataSize, true)
  const data = new Float32Array(out, 44)
  const chans = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c))
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) data[i * channels + c] = chans[c]![i]!
  return new Blob([out], { type: 'audio/wav' })
}
