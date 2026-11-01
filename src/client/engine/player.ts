import { type MixerState, LiveAudio } from './audioEngine'
import { PlaybackClock } from './clock'
import type { ItemSource } from './canvasDraw'
import { type CompositeLayer, Compositor, type FrameSource, layerOpacity } from './compositor'
import { type Scene, type VideoLayer, dipColorAt, emptyScene, heldSourceTime, layersAt, motionVideoOwner, transitionOpacity, videoFeeds } from './scene'
import { ImageCache, VideoPool } from './videoPool'

export interface PlayerAssetInfo {
  kind: 'video' | 'image' | 'audio'
  width: number
  height: number
  ready: boolean
  hasProxy: boolean
  /** Seconds (videos): past the end, a video holds its last frame. */
  duration?: number
  /** Copies to try for a still picture (Canvas elements), best first. */
  stills?: string[]
}

export interface PlayerOptions {
  canvas: HTMLCanvasElement
  poolContainer: HTMLElement
  asset: (id: string) => PlayerAssetInfo | undefined
  pending?: (clipId: string) => { label?: string; progress?: number | null } | undefined
  /** Live playhead (frame) — called whenever the displayed frame changes. */
  onFrame?: (frame: number) => void
  onPlayingChange?: (playing: boolean, rate: number) => void
  mixer: MixerState
}

const LOOKAHEAD_SECONDS = 1.5

/**
 * Timeline playback: AudioContext master clock, pooled proxy <video> elements for picture,
 * streamed WAV windows for sound, and the shared compositor for drawing.
 * Framework-agnostic — the Vue viewer only calls these methods; nothing here is reactive.
 */
export class Player {
  readonly clock = new PlaybackClock()
  readonly audio: LiveAudio
  private readonly pool: VideoPool
  private readonly images: ImageCache
  private readonly compositor = new Compositor()
  private readonly ctx: CanvasRenderingContext2D
  private scene: Scene = emptyScene()
  private _frame = 0
  private _rate = 0
  private reverseFrom = { wall: 0, frame: 0 }
  private dirty = true
  private raf = 0
  private destroyed = false
  private scale = 1
  private skimFrame: number | undefined

  constructor(private readonly opts: PlayerOptions) {
    const ctx = opts.canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('Canvas 2D is not available')
    this.ctx = ctx
    this.pool = new VideoPool(opts.poolContainer, 8, () => (this.dirty = true))
    this.images = new ImageCache(() => (this.dirty = true))
    this.audio = new LiveAudio(this.clock, opts.mixer)
    this.raf = requestAnimationFrame(this.tick)
  }

  get frame() {
    return this._frame
  }

  get rate() {
    return this._rate
  }

  get playing() {
    return this._rate !== 0
  }

  get fps() {
    return this.scene.fps
  }

  /** Frame currently shown: the skimmer while paused and skimming, otherwise the playhead. */
  get displayFrame() {
    return this._rate === 0 && this.skimFrame !== undefined ? this.skimFrame : this._frame
  }

  /** FCP skimming: preview a frame without moving the playhead (undefined = back to playhead). */
  skim(frame: number | undefined) {
    const next = frame === undefined ? undefined : Math.max(0, Math.min(Math.round(frame), Math.max(0, this.scene.duration - 1)))
    if (next === this.skimFrame) return
    this.skimFrame = next
    this.dirty = true
  }

  setScene(scene: Scene) {
    this.scene = scene
    this.audio.setScene(scene)
    this.scale = this.opts.canvas.width / Math.max(1, scene.width)
    this.dirty = true
  }

  setMixer(mixer: MixerState) {
    this.audio.setMixer(mixer)
  }

  /** Sizes the canvas backing store for the displayed CSS size (capped at project resolution). */
  resize(cssWidth: number, cssHeight: number) {
    const dpr = window.devicePixelRatio || 1
    const canvas = this.opts.canvas
    canvas.style.width = `${cssWidth}px`
    canvas.style.height = `${cssHeight}px`
    const w = Math.max(2, Math.min(Math.round(cssWidth * dpr), this.scene.width))
    const h = Math.max(2, Math.round((w * this.scene.height) / this.scene.width))
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    this.scale = w / Math.max(1, this.scene.width)
    this.dirty = true
  }

  invalidate() {
    this.dirty = true
  }

  async play(rate = 1) {
    if (this.scene.duration <= 0) return
    await this.clock.resume()
    if (rate > 0 && this._frame >= this.scene.duration - 1) this._frame = 0
    if (rate < 0 && this._frame <= 0) return
    this._rate = rate
    this.skimFrame = undefined
    if (rate > 0) {
      this.clock.start(this._frame / this.scene.fps, rate)
      if (rate === 1) this.audio.start()
      else this.audio.stop()
    } else {
      this.clock.stop(this._frame / this.scene.fps)
      this.audio.stop()
      this.pool.pauseAll()
      this.reverseFrom = { wall: performance.now(), frame: this._frame }
    }
    this.opts.onPlayingChange?.(true, rate)
  }

  pause() {
    if (this._rate > 0) {
      const f = Math.floor(this.clock.now() * this.scene.fps + 1e-6)
      this._frame = Math.max(0, Math.min(f, Math.max(0, this.scene.duration - 1)))
    }
    this.clock.stop(this._frame / this.scene.fps)
    this.audio.stop()
    this.pool.pauseAll()
    this._rate = 0
    this.skimFrame = undefined
    this.dirty = true
    this.opts.onPlayingChange?.(false, 0)
    this.opts.onFrame?.(this._frame)
  }

  toggle() {
    if (this.playing) this.pause()
    else void this.play(1)
  }

  /** J / K / L with FCP-style speed ramp (1×, 2×, 4×, 8×). */
  shuttle(key: 'j' | 'k' | 'l') {
    if (key === 'k') return this.pause()
    if (key === 'l') return void this.play(this._rate >= 1 ? Math.min(8, this._rate * 2) : 1)
    return void this.play(this._rate <= -1 ? Math.max(-8, this._rate * 2) : -1)
  }

  seek(frame: number) {
    const max = Math.max(0, this.scene.duration - 1)
    this._frame = Math.max(0, Math.min(Math.round(frame), max))
    // Moving the playhead (←/→, Home, a click) shows it even with the pointer resting on the timeline, until the pointer
    // moves again — the viewer kept the skimmed frame, and ⌘B cut one that wasn't on screen.
    this.skimFrame = undefined
    if (this._rate > 0) {
      this.clock.start(this._frame / this.scene.fps, this._rate)
      this.audio.stop()
      if (this._rate === 1) this.audio.start()
    } else if (this._rate < 0) {
      this.reverseFrom = { wall: performance.now(), frame: this._frame }
    }
    this.dirty = true
    this.opts.onFrame?.(this._frame)
  }

  step(delta: number) {
    if (this.playing) this.pause()
    this.seek(this._frame + delta)
  }

  destroy() {
    // Unmounted while playing (a workspace switch): report the stop, or the editor would still think it is playing.
    if (this.playing) this.pause()
    this.destroyed = true
    cancelAnimationFrame(this.raf)
    this.audio.stop()
    this.pool.destroy()
    this.images.destroy()
    void this.clock.ctx.close()
  }

  // ------------------------------------------------------------------ internals

  private tick = () => {
    if (this.destroyed) return
    this.raf = requestAnimationFrame(this.tick)
    const { fps, duration } = this.scene
    if (this._rate > 0) {
      const f = Math.floor(this.clock.now() * fps + 1e-6)
      if (f >= duration) {
        this._frame = Math.max(0, duration - 1)
        this.pause()
        return
      }
      if (f !== this._frame) {
        this._frame = f
        this.opts.onFrame?.(f)
      }
      this.syncVideos(true)
      this.draw()
      return
    }
    if (this._rate < 0) {
      const elapsed = (performance.now() - this.reverseFrom.wall) / 1000
      const f = Math.round(this.reverseFrom.frame + elapsed * fps * this._rate)
      if (f <= 0) {
        this._frame = 0
        this.pause()
        return
      }
      if (f !== this._frame) {
        this._frame = f
        this.dirty = true
        this.opts.onFrame?.(f)
      }
    }
    if (this.dirty) {
      this.syncVideos(false)
      this.draw()
      if (this.framesReady()) this.dirty = false
    }
  }

  private syncVideos(playing: boolean) {
    const { fps } = this.scene
    const frame = playing ? this._frame : this.displayFrame
    const active = layersAt(this.scene, frame)
    const upcoming = playing
      ? this.scene.video.filter((l) => l.start > frame && l.start <= frame + fps * LOOKAHEAD_SECONDS)
      : []
    const owners = new Set<string>()
    for (const feed of [...active, ...upcoming].flatMap(videoFeeds)) {
      const { layer } = feed
      const info = this.opts.asset(feed.assetId)
      if (!info?.ready || info.kind !== 'video') continue
      owners.add(feed.owner)
      const slot = this.pool.acquire(feed.owner, feed.assetId, `/media/${feed.assetId}/${info.hasProxy ? 'proxy' : 'original'}`)
      const isActive = frame >= layer.start && frame < layer.end
      const local = isActive ? (frame + 0.5 - layer.start) / fps : 0.5 / fps
      const wanted = layer.sourceStart + local * layer.speed
      const target = heldSourceTime(wanted, info.duration)
      const el = slot.el
      // Played to its end: paused on the last frame (play() on an ended video starts it over).
      if (playing && isActive && target === wanted) {
        const rate = this._rate * layer.speed
        if (el.paused) {
          if (Math.abs(el.currentTime - target) > 0.08) el.currentTime = target
          el.playbackRate = rate
          void el.play().catch(() => {})
        } else {
          const drift = el.currentTime - target
          if (Math.abs(drift) > 0.25) el.currentTime = target + 0.03
          else if (Math.abs(drift) > 0.5 / fps) el.playbackRate = rate * (drift > 0 ? 0.96 : 1.04)
          else if (el.playbackRate !== rate) el.playbackRate = rate
        }
      } else {
        if (!el.paused) el.pause()
        this.pool.seek(slot, target)
      }
    }
    this.pool.releaseExcept(owners)
  }

  private framesReady(): boolean {
    for (const layer of layersAt(this.scene, this.displayFrame)) {
      if (layer.kind === 'motion' && layer.motion) {
        for (const it of layer.motion.items) {
          if (it.kind !== 'asset' || !it.assetId) continue
          const info = this.opts.asset(it.assetId)
          if (info?.kind === 'image' && info.ready && !this.images.get(it.assetId, info.stills)) return false
        }
      }
      for (const feed of videoFeeds(layer)) {
        const info = this.opts.asset(feed.assetId)
        if (info?.kind === 'image') {
          if (!this.images.get(feed.assetId)) return false
          continue
        }
        const slot = this.pool.slotFor(feed.owner)
        if (info?.ready && (!slot || !slot.frameReady)) return false
      }
    }
    return true
  }

  private draw() {
    const { fps } = this.scene
    const frame = this.displayFrame
    const layers: CompositeLayer[] = []
    for (const layer of layersAt(this.scene, frame)) {
      const local = frame - layer.start
      const opacity = layerOpacity(layer, local) * transitionOpacity(layer, frame + 0.5)
      let source: FrameSource | undefined
      if (layer.kind === 'media' && layer.assetId) {
        const info = this.opts.asset(layer.assetId)
        if (info?.kind === 'image') {
          const bmp = this.images.get(layer.assetId)
          if (bmp) source = { image: bmp, imageWidth: bmp.width, imageHeight: bmp.height, width: info.width || bmp.width, height: info.height || bmp.height }
        } else {
          const slot = this.pool.slotFor(layer.clipId)
          const el = slot?.el
          if (el && el.readyState >= 2 && el.videoWidth) {
            source = {
              image: el,
              imageWidth: el.videoWidth,
              imageHeight: el.videoHeight,
              width: info?.width || el.videoWidth,
              height: info?.height || el.videoHeight,
            }
          } else {
            // Mid-seek (scrubbing): show the last decoded frame rather than black.
            const hold = this.pool.held(slot, layer.assetId)
            if (hold) source = { image: hold, imageWidth: hold.width, imageHeight: hold.height, width: info?.width || hold.width, height: info?.height || hold.height }
          }
        }
      }
      const pending = layer.kind === 'pending' ? this.opts.pending?.(layer.clipId) : undefined
      const itemSources = layer.kind === 'motion' ? this.motionSources(layer) : undefined
      layers.push({ layer, source, opacity, localFrame: local, itemSources, pendingLabel: pending?.label, pendingProgress: pending?.progress })
    }
    this.compositor.render(this.ctx, layers, {
      frame,
      fps,
      width: this.scene.width,
      height: this.scene.height,
      scale: this.scale,
      dip: dipColorAt(this.scene, frame),
    })
  }

  /** Pictures of a motion frame's asset elements: the playing video (or its held frame, then its poster), the image. */
  private motionSources(layer: VideoLayer): Record<string, ItemSource> {
    const out: Record<string, ItemSource> = {}
    for (const it of layer.motion?.items ?? []) {
      if (it.kind !== 'asset' || !it.assetId) continue
      const info = this.opts.asset(it.assetId)
      if (!info || info.kind === 'audio') continue
      if (info.kind === 'video') {
        const slot = this.pool.slotFor(motionVideoOwner(layer.clipId, it.id))
        const el = slot?.el
        if (el && el.readyState >= 2 && el.videoWidth) {
          out[it.id] = { image: el, width: el.videoWidth, height: el.videoHeight }
          continue
        }
        // Mid-seek or not decoded yet: the last frame, else the poster.
        const still = this.pool.held(slot, it.assetId) ?? this.images.get(`poster:${it.assetId}`, [`/media/${it.assetId}/poster`])
        if (still) out[it.id] = { image: still, width: still.width, height: still.height }
        continue
      }
      const bmp = this.images.get(it.assetId, info.stills)
      if (bmp) out[it.id] = { image: bmp, width: bmp.width, height: bmp.height }
    }
    return out
  }
}
