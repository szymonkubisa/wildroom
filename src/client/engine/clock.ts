/**
 * Master clock driven by the AudioContext. Picture time = what is being *heard* right now:
 * getOutputTimestamp() maps context time to performance.now(), so output latency (e.g. Bluetooth)
 * is compensated and video stays in sync with sound.
 */
export class PlaybackClock {
  readonly ctx: AudioContext
  private anchorMedia = 0
  private anchorCtx = 0
  private _rate = 0

  constructor() {
    this.ctx = new AudioContext({ sampleRate: 48_000, latencyHint: 'playback' })
  }

  get rate() {
    return this._rate
  }

  get running() {
    return this._rate !== 0
  }

  /** Context time of the sample reaching the speakers now. */
  heardContextTime(): number {
    const ts = this.ctx.getOutputTimestamp?.()
    if (ts?.contextTime !== undefined && ts.performanceTime !== undefined && ts.performanceTime > 0) {
      return ts.contextTime + Math.max(0, performance.now() - ts.performanceTime) / 1000
    }
    return this.ctx.currentTime - (this.ctx.outputLatency || this.ctx.baseLatency || 0)
  }

  /** Current media time in seconds. */
  now(): number {
    if (!this._rate) return this.anchorMedia
    const t = this.anchorMedia + (this.heardContextTime() - this.anchorCtx) * this._rate
    return this._rate > 0 ? Math.max(this.anchorMedia, t) : Math.min(this.anchorMedia, t)
  }

  /** Start at `mediaTime`; returns the context time at which that media time will start playing. */
  start(mediaTime: number, rate: number, leadSeconds = 0.08): number {
    this.anchorMedia = mediaTime
    this.anchorCtx = this.ctx.currentTime + leadSeconds
    this._rate = rate
    return this.anchorCtx
  }

  /** Context time at which a media time will play (valid while running). */
  contextTimeFor(mediaTime: number): number {
    return this.anchorCtx + (mediaTime - this.anchorMedia) / (this._rate || 1)
  }

  stop(atMedia?: number) {
    this.anchorMedia = atMedia ?? this.now()
    this._rate = 0
  }

  set(mediaTime: number) {
    this.anchorMedia = mediaTime
    if (this._rate) this.anchorCtx = this.heardContextTime()
  }

  async resume() {
    if (this.ctx.state !== 'running') await this.ctx.resume()
  }
}
