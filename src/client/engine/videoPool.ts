export interface PoolSlot {
  el: HTMLVideoElement
  assetId?: string
  owner?: string
  lastUsed: number
  seeking: boolean
  seekTarget?: number
  frameReady: boolean
  /**
   * Last decoded frame of this slot's asset. While a seek is in flight Chrome drops the element to
   * HAVE_METADATA and it cannot be drawn, so scrubbing shows this instead of black.
   */
  hold?: HTMLCanvasElement
  holdAssetId?: string
}

type VideoWithRvfc = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number
}

/**
 * Pool of muted <video> elements playing proxies. Elements stay in the DOM (1 px, transparent, inside the
 * viewer) so Chrome keeps decoding them; slots are re-bound to clips as the playhead moves.
 */
export class VideoPool {
  private slots: PoolSlot[] = []

  constructor(
    private readonly container: HTMLElement,
    private readonly size = 8,
    private readonly onFrame?: () => void,
  ) {}

  private create(): PoolSlot {
    const el = document.createElement('video')
    el.muted = true
    el.playsInline = true
    el.preload = 'auto'
    el.disablePictureInPicture = true
    el.style.cssText = 'position:absolute;left:0;bottom:0;width:1px;height:1px;opacity:0;pointer-events:none;'
    this.container.appendChild(el)
    const slot: PoolSlot = { el, lastUsed: 0, seeking: false, frameReady: false }
    this.slots.push(slot)
    return slot
  }

  /** Slot for a clip: its current slot, else one already holding the asset, else the least recently used. */
  acquire(owner: string, assetId: string, url: string): PoolSlot {
    const now = performance.now()
    let slot = this.slots.find((s) => s.owner === owner)
    if (!slot) slot = this.slots.find((s) => !s.owner && s.assetId === assetId)
    if (!slot && this.slots.length < this.size) slot = this.create()
    if (!slot) {
      const free = this.slots.filter((s) => !s.owner)
      slot = (free.length ? free : this.slots).reduce((a, b) => (a.lastUsed <= b.lastUsed ? a : b))
    }
    slot.owner = owner
    slot.lastUsed = now
    if (slot.assetId !== assetId) {
      slot.assetId = assetId
      slot.holdAssetId = undefined
      slot.frameReady = false
      slot.seekTarget = undefined
      slot.seeking = false
      slot.el.pause()
      slot.el.src = url
    }
    return slot
  }

  slotFor(owner: string): PoolSlot | undefined {
    return this.slots.find((s) => s.owner === owner)
  }

  pauseAll() {
    for (const slot of this.slots) if (!slot.el.paused) slot.el.pause()
  }

  /** Unbind slots whose clips are no longer active (they keep their media loaded for reuse). */
  releaseExcept(owners: Set<string>) {
    for (const slot of this.slots) {
      if (slot.owner && !owners.has(slot.owner)) {
        slot.owner = undefined
        if (!slot.el.paused) slot.el.pause()
      }
    }
  }

  /** Precise seek with coalescing: only the latest requested time is honoured. */
  seek(slot: PoolSlot, time: number) {
    const t = Math.max(0, time)
    if (slot.seekTarget !== undefined && Math.abs(slot.seekTarget - t) < 1e-4 && (slot.seeking || slot.frameReady)) return
    slot.seekTarget = t
    slot.frameReady = false
    if (!slot.seeking) this.runSeek(slot)
  }

  private runSeek(slot: PoolSlot) {
    const target = slot.seekTarget
    if (target === undefined) return
    const el = slot.el as VideoWithRvfc
    if (el.readyState < 1) {
      slot.seeking = true
      el.addEventListener(
        'loadedmetadata',
        () => {
          slot.seeking = false
          this.runSeek(slot)
        },
        { once: true },
      )
      return
    }
    slot.seeking = true
    const done = () => {
      slot.seeking = false
      if (slot.seekTarget !== undefined && Math.abs(slot.seekTarget - target) > 1e-4) {
        this.runSeek(slot)
        return
      }
      let fired = false
      const ready = () => {
        if (fired) return
        fired = true
        slot.frameReady = true
        this.onFrame?.()
      }
      el.requestVideoFrameCallback?.(ready)
      setTimeout(ready, 120) // rVFC may not fire for an unchanged frame
    }
    el.addEventListener('seeked', done, { once: true })
    // Hold the frame on screen now: after playback the last seek's frame would be far from here.
    this.capture(slot)
    el.currentTime = target
  }

  /** Keeps a copy of the frame the element currently shows (see `hold`). */
  capture(slot: PoolSlot) {
    const el = slot.el
    if (el.readyState < 2 || !el.videoWidth || !slot.assetId) return
    const hold = (slot.hold ??= document.createElement('canvas'))
    if (hold.width !== el.videoWidth || hold.height !== el.videoHeight) {
      hold.width = el.videoWidth
      hold.height = el.videoHeight
    }
    hold.getContext('2d')?.drawImage(el, 0, 0)
    slot.holdAssetId = slot.assetId
  }

  /** The held frame for `assetId`, if this slot has one. */
  held(slot: PoolSlot | undefined, assetId: string): HTMLCanvasElement | undefined {
    return slot?.hold && slot.holdAssetId === assetId ? slot.hold : undefined
  }

  destroy() {
    for (const slot of this.slots) {
      slot.el.pause()
      slot.el.removeAttribute('src')
      slot.el.load()
      slot.el.remove()
    }
    this.slots = []
  }
}

async function decodeFirst(urls: readonly string[]): Promise<ImageBitmap> {
  let error: unknown = new Error('No image to load')
  for (const url of urls) {
    try {
      const r = await fetch(url)
      if (!r.ok) throw new Error(String(r.status))
      return await createImageBitmap(await r.blob())
    } catch (err) {
      error = err // try the next copy
    }
  }
  throw error
}

/**
 * Decoded still images for image clips and Canvas elements, by key (an asset id). `urls` lists the copies to try,
 * best first (default: the original).
 */
export class ImageCache {
  private cache = new Map<string, Promise<ImageBitmap | undefined>>()
  private ready = new Map<string, ImageBitmap>()

  constructor(private readonly onLoad?: () => void) {}

  get(key: string, urls: readonly string[] = [`/media/${key}/original`]): ImageBitmap | undefined {
    const hit = this.ready.get(key)
    if (hit) return hit
    if (!this.cache.has(key)) {
      const p = decodeFirst(urls)
        .then((bmp) => {
          this.ready.set(key, bmp)
          this.onLoad?.()
          return bmp
        })
        .catch(() => {
          this.cache.delete(key)
          return undefined
        })
      this.cache.set(key, p)
    }
    return undefined
  }

  load(key: string, urls?: readonly string[]): Promise<ImageBitmap | undefined> {
    this.get(key, urls)
    return this.cache.get(key) ?? Promise.resolve(this.ready.get(key))
  }

  destroy() {
    for (const bmp of this.ready.values()) bmp.close()
    this.ready.clear()
    this.cache.clear()
  }
}
