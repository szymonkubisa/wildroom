import { evaluateMotion } from '@shared/motion/evaluate'
import { keyframeObject } from '@shared/timeline/keyframes'
import type { EffectInstance, Transform } from '@shared/types/project-doc'
import { fillColor } from '@shared/types/canvas'
import { type ItemSource, drawItems, fillRectWith } from './canvasDraw'
import { type MotionLayer, type VideoLayer, keyframeValue } from './scene'
import { TitleRenderer, titleMotion } from './titles'

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

export interface FrameSource {
  image: CanvasImageSource
  /** Intrinsic pixel size of `image` (proxy or original). */
  imageWidth: number
  imageHeight: number
  /** Logical size of the original media (conform "none" uses it). */
  width: number
  height: number
}

export interface CompositeLayer {
  layer: VideoLayer
  source?: FrameSource
  /** Final opacity (props × keyframes × transitions). */
  opacity: number
  localFrame: number
  /** Motion layers: decoded pictures of the frame's asset elements, by item id (missing = not drawn yet). */
  itemSources?: Record<string, ItemSource>
  pendingLabel?: string
  pendingProgress?: number | null
}

export interface RenderOptions {
  frame: number
  fps: number
  /** Project resolution. */
  width: number
  height: number
  /** Canvas pixels per project pixel. */
  scale: number
  /** Solid colour overlay for dip-to-white. */
  dip?: { color: string; amount: number }
}

function transformAt(layer: VideoLayer, localFrame: number): Transform {
  return keyframeObject(layer.video.transformKeys, localFrame, layer.video.transform)
}

export function layerOpacity(layer: VideoLayer, localFrame: number): number {
  return keyframeValue(layer.video.opacityKeys, localFrame, layer.video.opacity)
}

/** `media`: colour balance only applies to media layers (see drawOverlays). */
function effectFilter(effects: EffectInstance[], scale: number, media: boolean): string {
  const parts: string[] = []
  for (const fx of effects) {
    if (!fx.enabled) continue
    const p = fx.params
    switch (fx.type) {
      case 'color': {
        const exposure = Number(p.exposure ?? 0)
        const contrast = Number(p.contrast ?? 1)
        const saturation = Number(p.saturation ?? 1)
        const hue = Number(p.hue ?? 0)
        if (exposure) parts.push(`brightness(${(1 + exposure).toFixed(3)})`)
        if (contrast !== 1) parts.push(`contrast(${contrast.toFixed(3)})`)
        if (saturation !== 1) parts.push(`saturate(${saturation.toFixed(3)})`)
        if (hue) parts.push(`hue-rotate(${hue}deg)`)
        break
      }
      case 'balance': {
        if (!media) break
        // Channel gains: the brightest gain is applied here, the rest as a multiply tint in drawOverlays.
        const m = Math.max(Number(p.r ?? 1), Number(p.g ?? 1), Number(p.b ?? 1))
        if (m > 1) parts.push(`brightness(${m.toFixed(3)})`)
        break
      }
      case 'bw':
        parts.push(`grayscale(${Number(p.amount ?? 1)})`)
        break
      case 'sepia':
        parts.push(`sepia(${Number(p.amount ?? 1)})`)
        break
      case 'blur':
        parts.push(`blur(${(Number(p.radius ?? 4) * scale).toFixed(2)}px)`)
        break
    }
  }
  return parts.length ? parts.join(' ') : 'none'
}

/** Deterministic Canvas2D compositor shared by the live viewer and the export worker. */
export class Compositor {
  private readonly titles = new TitleRenderer()
  private noiseTile: OffscreenCanvas | HTMLCanvasElement | undefined

  render(ctx: Ctx2D, layers: CompositeLayer[], opts: RenderOptions) {
    const canvas = ctx.canvas
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalAlpha = 1
    ctx.filter = 'none'
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.setTransform(opts.scale, 0, 0, opts.scale, 0, 0)
    ctx.imageSmoothingQuality = 'high'
    for (const layer of layers) this.drawLayer(ctx, layer, opts)
    if (opts.dip && opts.dip.amount > 0) {
      ctx.globalAlpha = opts.dip.amount
      ctx.fillStyle = opts.dip.color
      ctx.fillRect(0, 0, opts.width, opts.height)
    }
    ctx.restore()
    this.titles.prune(new Set(layers.filter((l) => l.layer.kind === 'title').map((l) => l.layer.clipId)))
  }

  private tiltCanvases: [OffscreenCanvas, OffscreenCanvas] | undefined

  /**
   * A layer with a tilt-shift blur is drawn on its own, then laid down sharp with a blurred copy over it that fades in
   * above and below the sharp band (the miniature look of a shallow-focus lens).
   */
  private drawLayer(ctx: Ctx2D, cl: CompositeLayer, opts: RenderOptions) {
    const tilt = cl.layer.video.effects.find((fx) => fx.enabled && fx.type === 'tilt-blur')
    const radius = Number(tilt?.params.radius ?? 0)
    if (!tilt || radius <= 0 || typeof OffscreenCanvas === 'undefined') return this.drawLayerBody(ctx, cl, opts)
    const { width, height } = ctx.canvas
    if (!this.tiltCanvases || this.tiltCanvases[0].width !== width || this.tiltCanvases[0].height !== height)
      this.tiltCanvases = [new OffscreenCanvas(width, height), new OffscreenCanvas(width, height)]
    const [layerCanvas, blurCanvas] = this.tiltCanvases
    const l = layerCanvas.getContext('2d')!
    const b = blurCanvas.getContext('2d')!
    l.setTransform(1, 0, 0, 1, 0, 0)
    l.clearRect(0, 0, width, height)
    l.setTransform(ctx.getTransform())
    l.imageSmoothingQuality = 'high'
    this.drawLayerBody(l, cl, opts)
    b.setTransform(1, 0, 0, 1, 0, 0)
    b.globalCompositeOperation = 'source-over'
    b.clearRect(0, 0, width, height)
    b.filter = `blur(${(radius * opts.scale).toFixed(2)}px)`
    b.drawImage(layerCanvas, 0, 0)
    b.filter = 'none'
    // Opaque away from the band, clear inside it, soft edges as wide as the band.
    const focus = Number(tilt.params.focus ?? 0.5)
    const half = Number(tilt.params.size ?? 0.3) / 2
    const g = b.createLinearGradient(0, 0, 0, height)
    const stop = (at: number, a: number) => g.addColorStop(Math.min(1, Math.max(0, at)), `rgba(0,0,0,${a})`)
    stop(0, 1)
    stop(focus - half * 2, 1)
    stop(focus - half, 0)
    stop(focus + half, 0)
    stop(focus + half * 2, 1)
    stop(1, 1)
    b.globalCompositeOperation = 'destination-in'
    b.fillStyle = g
    b.fillRect(0, 0, width, height)
    b.globalCompositeOperation = 'source-over'
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalAlpha = 1
    ctx.drawImage(layerCanvas, 0, 0)
    ctx.drawImage(blurCanvas, 0, 0)
    ctx.restore()
  }

  private drawLayerBody(ctx: Ctx2D, cl: CompositeLayer, opts: RenderOptions) {
    const { layer } = cl
    const W = opts.width
    const H = opts.height
    let alpha = cl.opacity
    let dy = 0
    if (layer.kind === 'title' && layer.title) {
      const motion = titleMotion(layer.title, cl.localFrame, opts.fps)
      alpha *= motion.alpha
      dy = motion.dy
    }
    if (alpha <= 0.001) return
    const t = transformAt(layer, cl.localFrame)
    ctx.save()
    ctx.globalAlpha = Math.min(1, alpha)
    ctx.translate(W / 2 + t.x * W, H / 2 + (t.y + dy) * H)
    if (t.rotation) ctx.rotate((t.rotation * Math.PI) / 180)
    if (t.scale !== 1) ctx.scale(t.scale, t.scale)
    ctx.filter = effectFilter(layer.video.effects, opts.scale, layer.kind === 'media')

    let rect = { x: -W / 2, y: -H / 2, w: W, h: H }
    switch (layer.kind) {
      case 'media':
        if (cl.source) rect = this.drawMedia(ctx, cl.source, layer, W, H)
        break
      case 'generator':
        this.drawGenerator(ctx, layer, W, H)
        break
      case 'title':
        if (layer.title) ctx.drawImage(this.titles.render(layer.title, W, H, cl.localFrame, opts.fps), -W / 2, -H / 2, W, H)
        break
      case 'motion':
        if (layer.motion) this.drawMotion(ctx, layer.motion, cl, W, H)
        break
      case 'pending':
        this.drawPending(ctx, W, H, cl.pendingLabel ?? layer.label, cl.pendingProgress)
        break
    }
    ctx.filter = 'none'
    this.drawOverlays(ctx, layer.video.effects, rect, opts, layer.kind === 'media' && Boolean(cl.source))
    ctx.restore()
  }

  private drawMedia(ctx: Ctx2D, src: FrameSource, layer: VideoLayer, W: number, H: number) {
    const crop = layer.video.crop
    const sx = crop.left * src.imageWidth
    const sy = crop.top * src.imageHeight
    const sw = Math.max(1, src.imageWidth * (1 - crop.left - crop.right))
    const sh = Math.max(1, src.imageHeight * (1 - crop.top - crop.bottom))
    const lw = src.width * (1 - crop.left - crop.right)
    const lh = src.height * (1 - crop.top - crop.bottom)
    const conform = layer.video.conform
    const s = conform === 'fill' ? Math.max(W / lw, H / lh) : conform === 'fit' ? Math.min(W / lw, H / lh) : 1
    const dw = lw * s
    const dh = lh * s
    ctx.drawImage(src.image, sx, sy, sw, sh, -dw / 2, -dh / 2, dw, dh)
    return { x: -dw / 2, y: -dh / 2, w: dw, h: dh }
  }

  private drawGenerator(ctx: Ctx2D, layer: VideoLayer, W: number, H: number) {
    const g = layer.generator
    if (!g) return
    if (g.generator === 'gradient') {
      const angle = ((g.params.angle ?? 90) * Math.PI) / 180
      const dx = (Math.cos(angle) * W) / 2
      const dy = (Math.sin(angle) * H) / 2
      const grad = ctx.createLinearGradient(-dx, -dy, dx, dy)
      grad.addColorStop(0, g.params.color)
      grad.addColorStop(1, g.params.color2 ?? '#000')
      ctx.fillStyle = grad
    } else ctx.fillStyle = g.params.color
    ctx.fillRect(-W / 2, -H / 2, W, H)
  }

  /**
   * A Canvas frame fitted into the picture (letterboxed in the frame's colour, transparent without one), clipped to
   * the frame, seen through the clip's camera.
   */
  private drawMotion(ctx: Ctx2D, m: MotionLayer, cl: CompositeLayer, W: number, H: number) {
    const view = evaluateMotion(m.clip, m.frame, m.items, cl.localFrame)
    if (view.missing) {
      this.drawPlaceholder(ctx, W, H, 'Missing frame', m.clip.name)
      return
    }
    const { w, h } = view.size
    const s = Math.min(W / w, H / h)
    // Letterbox in the frame's colour (a gradient's first stop), then the frame itself.
    if (view.fill) {
      ctx.fillStyle = fillColor(view.fill)
      ctx.fillRect(-W / 2, -H / 2, W, H)
    }
    ctx.save()
    ctx.scale(s, s)
    if (view.fill && typeof view.fill !== 'string') fillRectWith(ctx, view.fill, { x: -w / 2, y: -h / 2, w, h })
    ctx.beginPath()
    ctx.rect(-w / 2, -h / 2, w, h)
    ctx.clip()
    const cam = view.camera
    if (cam.zoom !== 1) ctx.scale(cam.zoom, cam.zoom)
    ctx.translate(-w / 2 - cam.x, -h / 2 - cam.y)
    drawItems(ctx, view, (item) => cl.itemSources?.[item.id])
    ctx.restore()
  }

  private drawPending(ctx: Ctx2D, W: number, H: number, label: string | undefined, progress?: number | null) {
    this.drawPlaceholder(ctx, W, H, 'Generating…', label, progress)
  }

  private drawPlaceholder(ctx: Ctx2D, W: number, H: number, title: string, label: string | undefined, progress?: number | null) {
    ctx.fillStyle = '#16161c'
    ctx.fillRect(-W / 2, -H / 2, W, H)
    ctx.strokeStyle = 'rgba(255,255,255,0.05)'
    ctx.lineWidth = H * 0.02
    for (let x = -W; x < W; x += H * 0.08) {
      ctx.beginPath()
      ctx.moveTo(x - H / 2, H / 2)
      ctx.lineTo(x + H / 2, -H / 2)
      ctx.stroke()
    }
    ctx.fillStyle = 'rgba(255,255,255,0.85)'
    ctx.textAlign = 'center'
    ctx.font = `600 ${H * 0.045}px "Helvetica Neue", Arial, sans-serif`
    ctx.fillText(title, 0, -H * 0.01)
    if (label) {
      ctx.font = `400 ${H * 0.028}px "Helvetica Neue", Arial, sans-serif`
      ctx.fillStyle = 'rgba(255,255,255,0.55)'
      ctx.fillText(label.length > 70 ? `${label.slice(0, 69)}…` : label, 0, H * 0.05)
    }
    if (progress != null) {
      const w = W * 0.3
      ctx.fillStyle = 'rgba(255,255,255,0.15)'
      ctx.fillRect(-w / 2, H * 0.1, w, H * 0.008)
      ctx.fillStyle = 'rgba(140,140,255,0.9)'
      ctx.fillRect(-w / 2, H * 0.1, w * progress, H * 0.008)
    }
  }

  private drawOverlays(ctx: Ctx2D, effects: EffectInstance[], rect: { x: number; y: number; w: number; h: number }, opts: RenderOptions, media: boolean) {
    for (const fx of effects) {
      if (!fx.enabled) continue
      if (fx.type === 'balance') {
        // The multiply tint covers `rect`, which is only the picture itself for media; on titles, solids and
        // placeholders it is the whole frame and would tint the layers underneath.
        if (!media) continue
        const gains = [Number(fx.params.r ?? 1), Number(fx.params.g ?? 1), Number(fx.params.b ?? 1)]
        const m = Math.max(1, ...gains)
        if (gains.every((g) => Math.abs(g - m) < 0.001)) continue
        ctx.save()
        ctx.globalCompositeOperation = 'multiply'
        ctx.fillStyle = `rgb(${gains.map((g) => Math.round((255 * g) / m)).join(',')})`
        ctx.fillRect(rect.x, rect.y, rect.w, rect.h)
        ctx.restore()
      } else if (fx.type === 'vignette') {
        const amount = Number(fx.params.amount ?? 0.5)
        const cx = rect.x + rect.w / 2
        const cy = rect.y + rect.h / 2
        const r = Math.hypot(rect.w, rect.h) / 2
        const grad = ctx.createRadialGradient(cx, cy, r * 0.45, cx, cy, r)
        grad.addColorStop(0, 'rgba(0,0,0,0)')
        grad.addColorStop(1, `rgba(0,0,0,${Math.min(1, amount)})`)
        ctx.fillStyle = grad
        ctx.fillRect(rect.x, rect.y, rect.w, rect.h)
      } else if (fx.type === 'grain') {
        const tile = this.noise()
        const amount = Number(fx.params.amount ?? 0.25)
        const seed = (opts.frame * 7919) % 97
        ctx.save()
        ctx.globalAlpha *= Math.min(1, amount)
        ctx.globalCompositeOperation = 'overlay'
        const pattern = ctx.createPattern(tile as CanvasImageSource, 'repeat')
        if (pattern) {
          ctx.translate(rect.x - seed * 3, rect.y - seed * 5)
          ctx.fillStyle = pattern
          ctx.fillRect(seed * 3, seed * 5, rect.w, rect.h)
        }
        ctx.restore()
      } else if (fx.type === 'letterbox') {
        const aspect = Number(fx.params.aspect ?? 2.39)
        const barH = Math.max(0, (opts.height - opts.width / aspect) / 2)
        if (barH > 0) {
          ctx.save()
          ctx.setTransform(opts.scale, 0, 0, opts.scale, 0, 0)
          ctx.globalAlpha = 1
          ctx.fillStyle = '#000'
          ctx.fillRect(0, 0, opts.width, barH)
          ctx.fillRect(0, opts.height - barH, opts.width, barH)
          ctx.restore()
        }
      }
    }
  }

  /** 256 px tile of seeded noise (same pattern in preview and export). */
  private noise() {
    if (this.noiseTile) return this.noiseTile
    const size = 256
    const tile = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(size, size) : Object.assign(document.createElement('canvas'), { width: size, height: size })
    const ctx = tile.getContext('2d') as Ctx2D
    const img = ctx.createImageData(size, size)
    let seed = 1234567
    for (let i = 0; i < img.data.length; i += 4) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      const v = 128 + (((seed >> 8) & 0xff) - 128) * 0.9
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v
      img.data[i + 3] = 255
    }
    ctx.putImageData(img, 0, 0)
    this.noiseTile = tile
    return tile
  }
}
