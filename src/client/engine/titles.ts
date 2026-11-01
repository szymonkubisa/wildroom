import type { TitleClip } from '@shared/types/project-doc'

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
type AnyCanvas = HTMLCanvasElement | OffscreenCanvas

export const TITLE_FONTS = [
  'Helvetica Neue',
  'SF Pro Display',
  'Avenir Next',
  'Futura',
  'Georgia',
  'Didot',
  'Menlo',
  'Impact',
] as const

function makeCanvas(width: number, height: number): AnyCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height)
  const c = document.createElement('canvas')
  c.width = width
  c.height = height
  return c
}

function wrap(ctx: Ctx2D, text: string, maxWidth: number): string[] {
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean)
    if (!words.length) {
      lines.push('')
      continue
    }
    let line = words[0]!
    for (const word of words.slice(1)) {
      const candidate = `${line} ${word}`
      if (ctx.measureText(candidate).width > maxWidth) {
        lines.push(line)
        line = word
      } else line = candidate
    }
    lines.push(line)
  }
  return lines
}

/** Typewriter reveals characters over time; other animations are applied at draw time. */
export function visibleText(clip: TitleClip, localFrame: number, fps: number): string {
  if (clip.animation !== 'typewriter') return clip.text
  const chars = Math.floor((localFrame / fps) * 18)
  return clip.text.slice(0, Math.max(0, chars))
}

/** Opacity and vertical offset (fraction of height) for fade / slide animations. */
export function titleMotion(clip: TitleClip, localFrame: number, fps: number): { alpha: number; dy: number } {
  const ramp = Math.max(1, Math.round(fps * 0.5))
  const tail = clip.duration - localFrame
  const inP = Math.min(1, localFrame / ramp)
  const outP = Math.min(1, tail / ramp)
  const ease = (t: number) => 1 - (1 - t) ** 3
  switch (clip.animation) {
    case 'fade':
      return { alpha: Math.min(ease(inP), ease(outP)), dy: 0 }
    case 'slide-up':
      return { alpha: Math.min(ease(inP), ease(outP)), dy: (1 - ease(inP)) * 0.04 }
    default:
      return { alpha: 1, dy: 0 }
  }
}

/** Renders a title at project resolution. Cached by content so playback only draws a bitmap. */
export class TitleRenderer {
  private cache = new Map<string, { key: string; canvas: AnyCanvas }>()

  render(clip: TitleClip, width: number, height: number, localFrame: number, fps: number): AnyCanvas {
    const text = visibleText(clip, localFrame, fps)
    const key = JSON.stringify([text, clip.subtitle, clip.template, clip.style, width, height])
    const hit = this.cache.get(clip.id)
    if (hit?.key === key) return hit.canvas
    const canvas = makeCanvas(width, height)
    const ctx = canvas.getContext('2d') as Ctx2D
    this.draw(ctx, clip, text, width, height)
    this.cache.set(clip.id, { key, canvas })
    return canvas
  }

  private draw(ctx: Ctx2D, clip: TitleClip, text: string, W: number, H: number) {
    const s = clip.style
    const scale = H / 1080
    const size = s.fontSize * scale
    const family = `"${s.fontFamily}", "Helvetica Neue", Arial, sans-serif`
    ctx.clearRect(0, 0, W, H)
    ctx.textBaseline = 'alphabetic'
    const shadow = () => {
      if (!s.shadow) return
      ctx.shadowColor = 'rgba(0,0,0,0.65)'
      ctx.shadowBlur = 12 * scale
      ctx.shadowOffsetY = 3 * scale
    }

    if (clip.template === 'lower-third') {
      const x = W * 0.06
      const baseY = H * 0.82
      ctx.font = `${s.fontWeight} ${size}px ${family}`
      const lines = wrap(ctx, text, W * 0.6)
      const subSize = size * 0.55
      const lineH = size * 1.15
      const blockH = lines.length * lineH + (clip.subtitle ? subSize * 1.5 : 0) + size * 0.5
      const blockW =
        Math.max(...lines.map((l) => ctx.measureText(l).width), clip.subtitle ? (ctx.font = `400 ${subSize}px ${family}`, ctx.measureText(clip.subtitle).width) : 0) +
        size
      ctx.fillStyle = s.background ?? 'rgba(0,0,0,0.55)'
      ctx.fillRect(x - size * 0.5, baseY - blockH, blockW, blockH + size * 0.2)
      ctx.fillStyle = s.color
      ctx.textAlign = 'left'
      shadow()
      ctx.font = `${s.fontWeight} ${size}px ${family}`
      lines.forEach((l, i) => ctx.fillText(l, x, baseY - blockH + size * 0.25 + lineH * (i + 1) - size * 0.15))
      if (clip.subtitle) {
        ctx.font = `400 ${subSize}px ${family}`
        ctx.globalAlpha = 0.85
        ctx.fillText(clip.subtitle, x, baseY - size * 0.15)
        ctx.globalAlpha = 1
      }
      return
    }

    if (clip.template === 'caption') {
      const capSize = Math.max(size * 0.6, H * 0.045)
      ctx.font = `600 ${capSize}px ${family}`
      const lines = wrap(ctx, text, W * 0.8)
      const lineH = capSize * 1.25
      const bottom = H * 0.9
      ctx.textAlign = 'center'
      lines.forEach((l, i) => {
        const y = bottom - (lines.length - 1 - i) * lineH
        const w = ctx.measureText(l).width
        ctx.fillStyle = s.background ?? 'rgba(0,0,0,0.6)'
        ctx.fillRect(W / 2 - w / 2 - capSize * 0.35, y - capSize, w + capSize * 0.7, capSize * 1.3)
        ctx.fillStyle = s.color
        ctx.fillText(l, W / 2, y)
      })
      return
    }

    // basic + centered
    ctx.font = `${s.fontWeight} ${size}px ${family}`
    const align = clip.template === 'centered' ? 'center' : s.align
    const lines = wrap(ctx, text, W * 0.8)
    const lineH = size * 1.15
    const subSize = size * 0.45
    const total = lines.length * lineH + (clip.subtitle ? subSize * 1.8 : 0)
    let y = H / 2 - total / 2 + size * 0.9
    const x = align === 'left' ? W * 0.1 : align === 'right' ? W * 0.9 : W / 2
    ctx.textAlign = align
    ctx.fillStyle = s.color
    shadow()
    for (const l of lines) {
      ctx.fillText(l, x, y)
      y += lineH
    }
    if (clip.subtitle) {
      ctx.font = `400 ${subSize}px ${family}`
      ctx.globalAlpha = 0.8
      ctx.fillText(clip.subtitle, x, y + subSize * 0.4)
    }
  }

  prune(activeIds: Set<string>) {
    for (const id of this.cache.keys()) if (!activeIds.has(id)) this.cache.delete(id)
  }
}
