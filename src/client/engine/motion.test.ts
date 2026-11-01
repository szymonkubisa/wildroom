import { slideUpIn, stagger } from '@shared/motion/presets'
import { layoutTimeline, makeMotion } from '@shared/timeline'
import { makeDoc, mclip } from '@shared/timeline/test-utils'
import type { CanvasItem } from '@shared/types/canvas'
import type { MotionClip, ProjectDoc, RevealMode } from '@shared/types/project-doc'
import { describe, expect, it } from 'vitest'
import { buildScene } from './buildScene'
import { drawItem, focalCrop, revealLines, shapePerimeter, textBlock, textFonts, unitProgress, wrapLines } from './canvasDraw'
import { type CompositeLayer, Compositor, layerOpacity } from './compositor'
import { layersAt, transitionOpacity, videoFeeds } from './scene'
import { shownChars, wrapRuns } from './textLayout'

/** A 2D context that records what is drawn (calls, and the alpha/fill they are drawn with). */
function recorder(width = 1920, height = 1080) {
  const log: string[] = []
  const state: Record<string, unknown> = { globalAlpha: 1, fillStyle: '#000', font: '10px sans-serif', filter: 'none' }
  const stack: Record<string, unknown>[] = []
  const r = (n: number) => Math.round(n * 100) / 100
  const ctx = new Proxy({} as Record<string | symbol, unknown>, {
    get(_t, key) {
      if (key === 'canvas') return { width, height }
      if (key in state) return state[key as string]
      if (key === 'measureText') return (s: string) => ({ width: s.length * 20 })
      if (key === 'save') return () => stack.push({ ...state })
      if (key === 'restore') return () => Object.assign(state, stack.pop())
      return (...args: unknown[]) => {
        if (key === 'fill' || key === 'fillRect' || key === 'fillText' || key === 'drawImage' || key === 'stroke' || key === 'strokeText')
          log.push(`${String(key)}(${args.map((a) => (typeof a === 'number' ? r(a) : typeof a === 'string' ? a : '·')).join(',')}) α=${r(Number(state.globalAlpha))} ${String(state.fillStyle)}`)
        else if (key === 'translate' || key === 'scale' || key === 'rect') log.push(`${String(key)}(${args.map((a) => r(Number(a))).join(',')})`)
      }
    },
    set(_t, key, value) {
      state[key as string] = value
      return true
    },
  })
  return { ctx: ctx as unknown as CanvasRenderingContext2D, log }
}

const items: CanvasItem[] = [
  { id: 'F', kind: 'frame', name: 'Intro', x: 0, y: 0, w: 1920, h: 1080, fill: '#0b1020' },
  { id: 'S', kind: 'shape', shape: 'rect', fill: '#ff4466', radius: 24, x: 160, y: 200, w: 600, h: 300, frameId: 'F' },
  { id: 'T', kind: 'text', text: 'How it works', fontFamily: 'Inter', fontSize: 96, fontWeight: 700, color: '#ffffff', align: 'left', lineHeight: 1.2, x: 160, y: 600, w: 1400, h: 120, frameId: 'F' },
  { id: 'I', kind: 'asset', assetId: 'pic', x: 1100, y: 160, w: 640, h: 360, frameId: 'F' },
]

function sceneWith(clip: MotionClip, extra: Partial<ProjectDoc> = {}) {
  const doc: ProjectDoc = { ...makeDoc([mclip('A', 24), clip]), canvas: { boards: [{ id: 'B', name: 'Board', items }] }, ...extra }
  return buildScene(doc, layoutTimeline(doc), () => undefined)
}

const explainer = () => {
  let n = 0
  const tracks = stagger(['S', 'T', 'I'], 0, 6, (at) => slideUpIn({ at, frames: 14, distance: 40 }))
  return makeMotion({ duration: 72, newId: () => `m${++n}`, boardId: 'B', frameId: 'F', tracks, name: 'Intro' })
}

/** What the viewer and the export worker both do per frame: layers at f, their opacity, the shared compositor. */
function renderFrame(scene: ReturnType<typeof sceneWith>, f: number) {
  const { ctx, log } = recorder()
  const layers: CompositeLayer[] = layersAt(scene, f).map((layer) => {
    const local = f - layer.start
    return {
      layer,
      opacity: layerOpacity(layer, local) * transitionOpacity(layer, f + 0.5),
      localFrame: local,
      itemSources: layer.kind === 'motion' ? { I: { image: {} as CanvasImageSource, width: 1280, height: 720 } } : undefined,
    }
  })
  new Compositor().render(ctx, layers, { frame: f, fps: scene.fps, width: scene.width, height: scene.height, scale: 1 })
  return log
}

describe('motion layers', () => {
  it('buildScene resolves the frame from the board, with the clip’s offset as source start', () => {
    const scene = sceneWith({ ...explainer(), offset: 12 })
    const layer = scene.video.find((l) => l.kind === 'motion')!
    expect(layer.start).toBe(24)
    expect(layer.sourceStart).toBe(0.5)
    expect(layer.motion?.frame?.id).toBe('F')
    expect(layer.motion?.items.map((i) => i.id)).toEqual(['S', 'T', 'I'])
    expect(layer.still).toBe(true)
    expect(videoFeeds(layer)).toEqual([])
  })

  it('a deleted frame draws the “Missing frame” placeholder instead of failing', () => {
    const scene = sceneWith(explainer(), { canvas: { boards: [] } })
    const layer = scene.video.find((l) => l.kind === 'motion')!
    expect(layer.motion?.frame).toBeUndefined()
    expect(renderFrame(scene, 30).some((l) => l.startsWith('fillText(Missing frame'))).toBe(true)
  })

  it('three elements fade and slide in one after another — the same frame always draws the same', () => {
    const scene = sceneWith(explainer())
    const frames = [24, 30, 34, 44, 64].map((f) => renderFrame(scene, f))
    expect([24, 30, 34, 44, 64].map((f) => renderFrame(scene, f))).toEqual(frames)
    // Frame 0 of the clip: nothing is in yet — only the frame's background.
    expect(frames[0]!.filter((l) => /^(fill|fillText|drawImage)\(/.test(l))).toEqual([])
    // Six frames in: the shape is on its way, the text has just started, the picture not yet.
    expect(frames[1]!.some((l) => l.startsWith('fill() α=') && l.endsWith('#ff4466'))).toBe(true)
    expect(frames[1]!.some((l) => l.startsWith('drawImage('))).toBe(false)
    // Everything is in place by the end.
    const last = frames[4]!
    expect(last.some((l) => l === 'fill() α=1 #ff4466')).toBe(true)
    expect(last.some((l) => l.startsWith('fillText(How it works,160,') && l.includes('α=1 #ffffff'))).toBe(true)
    expect(last.some((l) => l.startsWith('drawImage(') && l.includes('α=1'))).toBe(true)
    expect(frames).toMatchSnapshot()
  })
})

describe('canvasDraw helpers', () => {
  it('reveals text by letters or words without reflowing', () => {
    const lines = wrapLines('Make videos from boards', 220, (s) => s.length * 20)
    expect(lines).toEqual(['Make videos', 'from boards'])
    expect(revealLines(lines, 0.5, 'typewriter')).toEqual(['Make videos', ''])
    expect(revealLines(lines, 0.25, 'typewriter')).toEqual(['Make v', ''])
    expect(revealLines(lines, 0.75, 'words')).toEqual(['Make videos', 'from'])
    expect(revealLines(lines, 1, 'words')).toEqual(lines)
  })

  it('lays out a text block the way the board shows it: wrapped lines, height past a short box', () => {
    const { ctx } = recorder()
    const item = items[2] as Extract<CanvasItem, { kind: 'text' }>
    const block = textBlock(ctx, { ...item, text: 'How it works on every board', w: 300, h: 10 })
    expect(block.lines).toEqual(['How it works on', 'every board'])
    expect(block.height).toBeCloseTo(2 * 96 * 1.2, 6)
    expect(ctx.font).toContain('"Inter"')
  })

  it('measures outlines for the draw reveal', () => {
    expect(shapePerimeter('rect', 100, 50)).toBe(300)
    expect(shapePerimeter('rect', 100, 50, 10)).toBeCloseTo(300 - (8 - 2 * Math.PI) * 10, 9)
    expect(shapePerimeter('ellipse', 100, 100)).toBeCloseTo(Math.PI * 100, 6)
  })
})

describe('picture crop', () => {
  it('centres a zoomed cover crop on the focus and keeps it inside the picture', () => {
    expect(focalCrop(1000, 500, { w: 100, h: 100 }, { x: 0.5, y: 0.5, zoom: 1 })).toEqual({ x: 250, y: 0, w: 500, h: 500 })
    expect(focalCrop(1000, 500, { w: 100, h: 100 }, { x: 0.5, y: 0.5, zoom: 2 })).toEqual({ x: 375, y: 125, w: 250, h: 250 })
    expect(focalCrop(1000, 500, { w: 100, h: 100 }, { x: 0, y: 1, zoom: 2 })).toEqual({ x: 0, y: 250, w: 250, h: 250 })
  })
})

describe('rich text', () => {
  const measure = (s: string, style: number) => s.length * (style === 1 ? 30 : 20)

  it('wraps across spans, a word changing look halfway stays one word', () => {
    const lines = wrapRuns(
      [
        { text: 'RULES OF THE GA', style: 0 },
        { text: 'ME now', style: 1 },
      ],
      300,
      measure,
    )
    expect(lines).toEqual([[{ text: 'RULES OF THE', style: 0 }], [{ text: 'GA', style: 0 }, { text: 'ME now', style: 1 }]])
  })

  it('reveals words across spans and lines', () => {
    expect(shownChars(['RULES OF', 'THE GAME', 'now'], 0.6, 'words')).toEqual([8, 3, 0])
    expect(shownChars(['ab', 'cd'], 0.75, 'typewriter')).toEqual([2, 1])
  })

  it('draws each span in its font and colour, highlight behind, case applied', () => {
    const { ctx, log } = recorder()
    const fonts: string[] = []
    const spy = new Proxy(ctx, {
      get: (t, k) => (k === 'fillText' ? (...a: unknown[]) => (fonts.push(String((t as unknown as CanvasRenderingContext2D).font)), (t as never as Record<string, (...x: unknown[]) => void>).fillText!(...a)) : Reflect.get(t, k)),
      set: (t, k, v) => Reflect.set(t, k, v),
    })
    const item = {
      ...(items[2] as Extract<CanvasItem, { kind: 'text' }>),
      text: 'the game',
      spans: [{ text: 'the ' }, { text: 'game', color: '#ffd400', fontStyle: 'italic' as const, highlight: '#222222' }],
      textTransform: 'uppercase' as const,
      w: 2000,
    }
    drawItem(spy, { item, rect: { x: 0, y: 0, w: 2000, h: 120 }, scale: 1, rotation: 0, opacity: 1, reveal: 1 }, () => undefined)
    const drawn = log.filter((l) => /^(fillText|fillRect)/.test(l))
    expect(drawn[0]).toMatch(/^fillRect\(.*#222222$/)
    expect(drawn.slice(1)).toEqual(['fillText(THE ,0,9.6) α=1 #ffffff', 'fillText(GAME,80,9.6) α=1 #ffd400'])
    expect(fonts[1]).toBe('italic 700 96px "Inter", Inter, system-ui, sans-serif')
    expect(textFonts(item)).toEqual(['700 96px "Inter", Inter, system-ui, sans-serif', 'italic 700 96px "Inter", Inter, system-ui, sans-serif'])
  })

  it('draws a glow, then the outline (with the shadow), then the letters', () => {
    const { ctx, log } = recorder()
    const item = {
      ...(items[2] as Extract<CanvasItem, { kind: 'text' }>),
      text: 'Hi',
      outline: { color: '#000000', width: 4 },
      glow: { color: '#00ffff', blur: 20 },
      shadow: { color: '#00000080', blur: 8, x: 0, y: 6 },
    }
    drawItem(ctx, { item, rect: { x: 0, y: 0, w: 400, h: 120 }, scale: 1, rotation: 0, opacity: 1, reveal: 1 }, () => undefined)
    expect(log.filter((l) => /^(fillText|strokeText)/.test(l)).map((l) => l.split('(')[0])).toEqual(['fillText', 'strokeText', 'fillText'])
  })
})

describe('kinetic text', () => {
  const text = (over: Partial<Extract<CanvasItem, { kind: 'text' }>>) => ({ ...(items[2] as Extract<CanvasItem, { kind: 'text' }>), w: 2000, ...over })
  const run = (item: Extract<CanvasItem, { kind: 'text' }>, reveal: number, revealMode: RevealMode, rollFrom?: number) => {
    const { ctx, log } = recorder()
    drawItem(ctx, { item, rect: { x: 0, y: 0, w: 2000, h: 120 }, scale: 1, rotation: 0, opacity: 1, reveal, revealMode, rollFrom }, () => undefined)
    return log.filter((l) => /^(fillText|fillRect)/.test(l))
  }

  it('words start one after another, each over a few words of time', () => {
    expect([0, 1, 2, 3].map((i) => unitProgress(i, 4, 0))).toEqual([0, 0, 0, 0])
    expect([0, 1, 2, 3].map((i) => unitProgress(i, 4, 1))).toEqual([1, 1, 1, 1])
    const mid = [0, 1, 2, 3].map((i) => unitProgress(i, 4, 0.5))
    expect(mid[0]).toBe(1)
    expect(mid[3]).toBe(0)
  })

  it('words rise in: the first is in place, the last not drawn yet', () => {
    const drawn = run(text({ text: 'one two three four' }), 0.5, 'words-rise')
    expect(drawn[0]).toBe('fillText(one,0,9.6) α=1 #ffffff')
    expect(drawn.some((l) => l.startsWith('fillText(four'))).toBe(false)
  })

  it('a highlight sweeps under the marked word only, text drawn whole from the start', () => {
    const item = text({ text: 'the game', spans: [{ text: 'the ' }, { text: 'game', highlight: '#222222' }] })
    const half = run(item, 0.5, 'highlight-sweep')
    expect(half.filter((l) => l.startsWith('fillRect')).length).toBe(1)
    expect(half[0]).toBe('fillRect(76.16,13.44,43.84,92.16) α=1 #222222')
    expect(run(item, 0, 'highlight-sweep').map((l) => l.split('(')[0])).toEqual(['fillText', 'fillText'])
  })

  it('numbers count like an odometer: digits in their final places, done on the number written', () => {
    const item = text({ text: 'Year 1970' })
    expect(run(item, 1, 'roll', 1920).filter((l) => l.startsWith('fillText')).map((l) => l.split(',')[0])).toEqual([
      'fillText(Year ',
      'fillText(1',
      'fillText(9',
      'fillText(7',
      'fillText(0',
    ])
    // Halfway from 1920: 1945 — the last digit sits on 5, the tens column on 4.
    const mid = run(item, 0.5, 'roll', 1920).filter((l) => l.startsWith('fillText')).map((l) => l.split(',')[0])
    expect(mid).toEqual(['fillText(Year ', 'fillText(1', 'fillText(9', 'fillText(4', 'fillText(5'])
    // 1949.5 on the way to 1950: the units turn 9 → 0 and carry the tens 4 → 5 with them, the rest stay.
    const carry = run(item, 0.595, 'roll', 1920).filter((l) => l.startsWith('fillText')).map((l) => l.split(',')[0])
    expect(carry).toEqual(['fillText(Year ', 'fillText(1', 'fillText(9', 'fillText(4', 'fillText(5', 'fillText(9', 'fillText(0'])
  })
})
