import { describe, expect, it } from 'vitest'
import { shapeOutline } from '../canvas/path'
import type { AlignedWord } from '../types/assets'
import {
  DEFAULT_THEME,
  EXPLAINER_LAYOUTS,
  EXPLAINER_STYLES,
  type ExplainerScene,
  PUSH_IN,
  type RawExplainer,
  VOICE_LEAD,
  capPictures,
  cueSeconds,
  elementMove,
  estimateWords,
  explainerEstimate,
  layoutScene,
  sanitizeExplainer,
  sceneFrames,
  sceneMotion,
  type SharedElements,
} from './explainer'

const el = (o: Partial<RawExplainer['scenes'][number]['elements'][number]>) => ({ kind: 'text', text: '', prompt: '', shape: '', cue: '', animation: 'fade-in', key: '', ...o })

const scene: ExplainerScene = {
  title: 'Solar power',
  voiceover: 'Sunlight hits the panel. The panel makes electricity for your home.',
  zoom: true,
  layout: 'column',
  elements: [
    { kind: 'title', text: 'How solar works', prompt: '', shape: 'rect', cue: '', animation: 'slide-up-in', key: '' },
    { kind: 'shape', text: '', prompt: '', shape: 'rect', cue: '', animation: 'draw', key: '' },
    { kind: 'text', text: 'Panels turn light into power', prompt: '', shape: 'rect', cue: 'makes electricity', animation: 'typewriter', key: '' },
    { kind: 'image', text: '', prompt: 'A rooftop with solar panels at noon', shape: 'rect', cue: 'panel', animation: 'pop', key: '' },
  ],
}

const words: AlignedWord[] = [
  ['Sunlight', 0, 0.5],
  ['hits', 0.5, 0.7],
  ['the', 0.7, 0.8],
  ['panel.', 0.8, 1.2],
  ['The', 1.4, 1.5],
  ['panel', 1.5, 1.9],
  ['makes', 1.9, 2.2],
  ['electricity', 2.2, 2.9],
].map(([text, start, end]) => ({ text: text as string, start: start as number, end: end as number }))

let n = 0
const newId = () => `x${++n}`

describe('sanitizeExplainer', () => {
  it('keeps valid scenes, fixes kinds, layouts and animations, three pictures per scene', () => {
    const out = sanitizeExplainer({
      title: '  Solar  ',
      style: 'flat illustration',
      scenes: [
        {
          title: '',
          voiceover: 'Light becomes power.',
          zoom: true,
          layout: 'swirl',
          elements: [
            el({ kind: 'title', text: 'Solar', animation: 'explode', key: '' }),
            el({ kind: 'image', prompt: 'panels', animation: 'typewriter', key: 'The Hero!' }),
            el({ kind: 'image', prompt: 'second picture' }),
            el({ kind: 'text', text: '' }),
            el({ kind: 'circle', text: 'Becomes text', shape: 'ellipse', animation: 'draw' }),
            el({ kind: 'number', text: '73%', animation: 'count-up' }),
            el({ kind: 'line', animation: 'count-up' }),
          ],
        },
        { title: 'Empty', voiceover: 'Nothing to show.', zoom: false, layout: 'cards', elements: [el({ kind: 'text', text: '' })] },
        { title: 'No voice', voiceover: '', zoom: false, layout: 'cards', elements: [el({ kind: 'title', text: 'Hi' })] },
      ],
    })!
    expect(out.title).toBe('Solar')
    expect(out.scenes).toHaveLength(1)
    const s = out.scenes[0]!
    expect(s.title).toBe('Light becomes power.')
    expect(s.layout).toBe('column')
    expect(s.elements.map((e) => [e.kind, e.animation])).toEqual([
      ['title', 'auto'],
      ['image', 'auto'],
      ['image', 'fade-in'],
      ['text', 'auto'],
      ['number', 'count-up'],
      ['line', 'auto'],
    ])
    expect(s.elements[1]!.key).toBe('the-hero-')
    expect(s.zoom).toBe(true)
    expect(sanitizeExplainer({ title: '', style: '', scenes: [] })).toBeUndefined()
  })

  it('estimates the size of an explainer before it is written', () => {
    expect(explainerEstimate(45)).toEqual({ scenes: 6, images: 7, chars: 675 })
    expect(explainerEstimate(5).scenes).toBe(2)
    expect(explainerEstimate(600).scenes).toBe(40)
  })
})

describe('capPictures', () => {
  const pic = (prompt: string, key = '') => ({ ...scene.elements[3]!, prompt, key })
  const ex = {
    title: 'T',
    style: '',
    scenes: [
      { ...scene, elements: [scene.elements[0]!, pic('a1', 'hero'), pic('a2'), pic('a3')] },
      { ...scene, elements: [pic('b1', 'hero'), pic('b2')] },
      { ...scene, elements: [pic('c1')] },
    ],
  }
  const prompts = (e: typeof ex) => e.scenes.map((sc) => sc.elements.filter((x) => x.kind === 'image').map((x) => x.prompt))

  it('keeps every scene’s first picture before any second one, a repeated key for free', () => {
    expect(prompts(capPictures(ex, 3))).toEqual([['a1', 'a2'], ['b1'], ['c1']])
    expect(prompts(capPictures(ex, 2))).toEqual([['a1'], ['b1'], ['c1']])
    expect(prompts(capPictures(ex, 9))).toEqual(prompts(ex))
    expect(capPictures(ex, 0).scenes[0]!.elements).toEqual([scene.elements[0]])
  })
})

describe('layoutScene', () => {
  it('stacks the words by the measured height of each text when the board measures them', () => {
    const at = { x: 0, y: 0, w: 1920, h: 1080 }
    const l = layoutScene(scene, at, DEFAULT_THEME, newId, (t) => t.fontSize * t.lineHeight * 3)
    const [title, bar, text] = l.itemIds.map((id) => l.items.find((i) => i.id === id))
    expect(title!.h).toBe(Math.round(title!.kind === 'text' ? title!.fontSize * title!.lineHeight * 3 : 0))
    expect(bar!.y).toBeGreaterThanOrEqual(title!.y + title!.h)
    expect(text!.h).toBe(Math.round(text!.kind === 'text' ? text!.fontSize * text!.lineHeight * 3 : 0))
  })

  it('puts words in a column on the left and the picture on the right, all in the frame', () => {
    const at = { x: 3000, y: 0, w: 1920, h: 1080 }
    const l = layoutScene(scene, at, DEFAULT_THEME, newId)
    expect(l.frame).toMatchObject({ kind: 'frame', name: 'Solar power', fill: DEFAULT_THEME.background, ...at })
    expect(l.itemIds).toHaveLength(4)
    expect(l.items.every((i) => i.frameId === l.frame.id)).toBe(true)
    const [title, bar, text, picture] = l.itemIds.map((id) => l.items.find((i) => i.id === id))
    expect(title).toMatchObject({ kind: 'text', fontWeight: 700, x: 3000 + 86 })
    expect(bar!.y).toBeGreaterThan(title!.y + title!.h - 1)
    expect(text!.y).toBeGreaterThan(bar!.y)
    expect(picture).toMatchObject({ kind: 'asset', planned: { prompt: 'A rooftop with solar panels at noon' } })
    expect(picture!.x).toBeGreaterThan(title!.x + title!.w)
    for (const i of l.items) {
      expect(i.x + i.w).toBeLessThanOrEqual(at.x + at.w)
      expect(i.y + i.h).toBeLessThanOrEqual(at.y + at.h)
    }
  })

  it('uses the whole width for words when there is no picture', () => {
    const l = layoutScene({ ...scene, elements: scene.elements.slice(0, 1) }, { x: 0, y: 0, w: 1920, h: 1080 }, DEFAULT_THEME, newId)
    expect(l.items[0]!.w).toBe(1920 - 2 * 86)
  })

  const frame = { x: 0, y: 0, w: 1920, h: 1080 }
  const inFrame = (l: ReturnType<typeof layoutScene>) => {
    for (const i of l.items) {
      expect(i.x, i.id).toBeGreaterThanOrEqual(-1)
      expect(i.y, i.id).toBeGreaterThanOrEqual(-1)
      expect(i.x + i.w, i.id).toBeLessThanOrEqual(1921)
      expect(i.y + i.h, i.id).toBeLessThanOrEqual(1081)
    }
  }

  it('lays out every layout inside the frame, in every style', () => {
    const picture = { ...scene.elements[3]!, key: '' }
    for (const layout of EXPLAINER_LAYOUTS)
      for (const style of Object.values(EXPLAINER_STYLES)) {
        const sc: ExplainerScene = {
          ...scene,
          layout,
          elements: [scene.elements[0]!, { ...scene.elements[2]!, kind: 'number', text: '1970', animation: 'auto' }, scene.elements[2]!, picture, { ...picture, prompt: 'two' }],
        }
        const l = layoutScene(sc, frame, style, newId)
        expect(l.itemIds.filter(Boolean), `${layout} · ${style.id}`).toHaveLength(5)
        inFrame(l)
      }
  })

  it('keeps a style’s arcs and rings off the words', () => {
    const picture = { ...scene.elements[3]!, key: '' }
    for (const layout of EXPLAINER_LAYOUTS)
      for (const style of [EXPLAINER_STYLES['minimal-duotone'], EXPLAINER_STYLES['dark-editorial']]) {
        const sc: ExplainerScene = { ...scene, layout, elements: [{ ...scene.elements[0]!, text: 'Hidden pigments everywhere' }, scene.elements[2]!, picture] }
        const l = layoutScene(sc, frame, style, newId)
        const texts = l.items.filter((i) => i.kind === 'text' && i.align === 'left')
        for (const d of l.items)
          if (d.kind === 'shape' && d.fill === 'none' && l.extras.some((e) => e.id === d.id && e.after === -1))
            for (const [px, py] of shapeOutline(d, d.w, d.h)[0]!.points)
              for (const t of texts)
                expect(d.x + px > t.x && d.x + px < t.x + Math.min(t.w, 300) && d.y + py > t.y && d.y + py < t.y + t.h, `${layout} · ${style.id}`).toBe(false)
      }
  })

  it('a diagram puts its points round a ring, joined by lines that draw as the points come in', () => {
    const sc: ExplainerScene = { ...scene, layout: 'diagram', elements: [scene.elements[0]!, ...['Victim', 'Rescuer', 'Persecutor'].map((text) => ({ ...scene.elements[2]!, text, cue: '' }))] }
    const l = layoutScene(sc, frame, EXPLAINER_STYLES['dark-editorial'], newId)
    expect(l.extras.filter((x) => x.preset === 'draw')).toHaveLength(6 + 2) // 3 rings, 3 lines, the style's 2 neon rings
    const lines = l.items.filter((i) => i.kind === 'shape' && i.shape === 'line')
    expect(lines).toHaveLength(3)
    expect(l.items.filter((i) => i.kind === 'text').map((t) => t.kind === 'text' && t.align)).toEqual(['left', 'center', 'center', 'center'])
  })

  it('a keyed element stays from one scene to the next: same place, there from the cut', () => {
    const shared: SharedElements = new Map()
    const hero = { ...scene.elements[3]!, key: 'hero' }
    const first = layoutScene({ ...scene, elements: [scene.elements[0]!, hero] }, frame, DEFAULT_THEME, newId, undefined, shared)
    const next = layoutScene({ ...scene, layout: 'center', elements: [{ ...scene.elements[0]!, text: 'Next' }, { ...hero, prompt: 'ignored' }] }, { ...frame, x: 2000 }, DEFAULT_THEME, newId, undefined, shared)
    const a = first.items.find((i) => i.id === first.itemIds[1])!
    const b = next.items.find((i) => i.id === next.itemIds[1])!
    expect([b.x - 2000, b.y, b.w, b.h]).toEqual([a.x, a.y, a.w, a.h])
    expect(b.kind === 'asset' && b.planned?.prompt).toBe(scene.elements[3]!.prompt)
    expect(next.kept).toEqual([b.id])
    expect(next.keyOf[b.id]).toBe('hero')
    expect(sceneMotion({ ...scene, elements: [scene.elements[0]!, hero] }, next, words, 120, 24).tracks[b.id]).toBeUndefined()
  })

  it('a key is matched by kind too, and said twice in one scene is laid out twice', () => {
    const shared: SharedElements = new Map()
    layoutScene({ ...scene, elements: [scene.elements[0]!, { ...scene.elements[3]!, key: 'hero' }] }, frame, DEFAULT_THEME, newId, undefined, shared)
    const next = layoutScene({ ...scene, elements: [{ ...scene.elements[2]!, key: 'hero' }] }, { ...frame, x: 2000 }, DEFAULT_THEME, newId, undefined, shared)
    expect(next.items.find((i) => i.id === next.itemIds[0])).toMatchObject({ kind: 'text', text: scene.elements[2]!.text })
    expect(next.kept).toEqual([])
    const twice = layoutScene({ ...scene, elements: [{ ...scene.elements[2]!, key: 'x' }, { ...scene.elements[2]!, text: 'Other', key: 'x' }] }, frame, DEFAULT_THEME, newId, undefined, new Map())
    const [a, b] = twice.itemIds.map((id) => twice.items.find((i) => i.id === id)!)
    expect(b!.y).toBeGreaterThan(a!.y)
  })

  it('a portrait frame keeps its words and pictures inside it', () => {
    const tall = { x: 0, y: 0, w: 1080, h: 1920 }
    const long = { ...scene.elements[2]!, text: 'Panels on the roof turn the light of the sun into power for the house all day long' }
    const pics = [scene.elements[3]!, { ...scene.elements[3]!, prompt: 'A meter' }]
    for (const layout of ['center', 'full-bleed', 'column'] as const) {
      const l = layoutScene({ ...scene, layout, elements: [{ ...scene.elements[0]!, text: 'How the sun powers a home' }, long, ...pics] }, tall, DEFAULT_THEME, newId)
      for (const id of l.itemIds) {
        const it = l.items.find((i) => i.id === id)!
        expect(it.y + it.h, `${layout} ${it.kind}`).toBeLessThanOrEqual(tall.h)
      }
    }
  })

  it('a diagram keeps one picture: it has one slot', () => {
    const raw = { title: 'T', style: '', scenes: [{ title: 'S', voiceover: 'v', zoom: false, layout: 'diagram', elements: [el({ kind: 'image', prompt: 'a' }), el({ kind: 'image', prompt: 'b' })] }] } as RawExplainer
    expect(sanitizeExplainer(raw)!.scenes[0]!.elements.filter((e) => e.kind === 'image')).toHaveLength(1)
  })

  it('styles dress the pictures and the words: duotone cut-outs, masks, serif-italic accents, decoration', () => {
    const duo = layoutScene(scene, frame, EXPLAINER_STYLES['minimal-duotone'], newId)
    const pic = duo.items.find((i) => i.id === duo.itemIds[3])!
    expect(pic).toMatchObject({ kind: 'asset', duotone: EXPLAINER_STYLES['minimal-duotone'].picture.duotone })
    const title = duo.items.find((i) => i.id === duo.itemIds[0])!
    expect(title.kind === 'text' && title.spans?.at(-1)).toMatchObject({ text: 'works', fontStyle: 'italic', fontFamily: 'Georgia' })
    expect(duo.items.some((i) => i.kind === 'shape' && typeof i.fill === 'object' && i.fill.type === 'pattern' && i.fill.pattern === 'barcode')).toBe(true)
    const tech = layoutScene(scene, frame, EXPLAINER_STYLES['mono-3d'], newId)
    expect(tech.items.find((i) => i.id === tech.itemIds[3])).toMatchObject({ mask: 'rounded', adjust: { bw: 1 } })
    // Markup in the Director's text becomes rich text.
    const marked = layoutScene({ ...scene, elements: [{ ...scene.elements[0]!, text: 'The ==drama== triangle' }] }, frame, DEFAULT_THEME, newId)
    const t = marked.items.find((i) => i.id === marked.itemIds[0])!
    expect(t.kind === 'text' && t.text).toBe('The drama triangle')
    expect(t.kind === 'text' && t.spans?.[1]).toMatchObject({ text: 'drama', highlight: expect.any(String) })
  })
})

describe('timing to the voice', () => {
  it('finds each cue in order, multi-word cues included', () => {
    expect(cueSeconds(['panel', 'panel', 'makes electricity', '', 'moon'], words)).toEqual([0.8, 1.5, 1.9, undefined, undefined])
    expect(cueSeconds(['Electricity!'], words)).toEqual([2.2])
  })

  it('spreads estimated word times over the length by word size', () => {
    const w = estimateWords('one three', 2)
    expect(w.map((x) => x.text)).toEqual(['one', 'three'])
    expect(w[0]!.start).toBe(0)
    expect(w[1]!.end).toBeCloseTo(2, 3)
    expect(w[1]!.start).toBeCloseTo(4 / 10 * 2, 3)
  })

  it('a scene lasts its voice plus lead and tail, at least 3 s', () => {
    expect(sceneFrames(3, 24)).toBe(Math.round((VOICE_LEAD + 3 + 0.8) * 24))
    expect(sceneFrames(0.5, 24)).toBe(72)
  })

  it('a style’s highlighter only sweeps under marked words', () => {
    const style = EXPLAINER_STYLES['dark-editorial']
    expect(elementMove({ ...scene.elements[2]!, animation: 'auto' }, style)).toBe('words-rise')
    expect(elementMove({ ...scene.elements[2]!, text: 'Say ==no== kindly', animation: 'auto' }, style)).toBe('highlight')
    const l = layoutScene({ ...scene, elements: [{ ...scene.elements[2]!, text: 'Say ==no== kindly' }] }, { x: 0, y: 0, w: 1920, h: 1080 }, style, newId)
    const t = l.items.find((i) => i.id === l.itemIds[0])!
    expect(t.kind === 'text' && t.spans?.[1]).toMatchObject({ text: 'no', color: '#111111' })
  })

  it('auto moves are the style’s; the style can float its pictures', () => {
    const auto: ExplainerScene = { ...scene, elements: scene.elements.map((e) => ({ ...e, animation: 'auto' as const })) }
    const style = EXPLAINER_STYLES['minimal-duotone']
    const l = layoutScene(auto, { x: 0, y: 0, w: 1920, h: 1080 }, style, newId)
    const m = sceneMotion(auto, l, words, 120, 24, style)
    expect(m.tracks[l.itemIds[0]!]!.revealMode).toBe('words-rise')
    expect(m.tracks[l.itemIds[3]!]!.behaviors?.[0]?.kind).toBe('float')
    // Decoration comes in too.
    for (const x of l.extras) expect(m.tracks[x.id], x.id).toBeDefined()
  })

  it('elements enter as the narrator says their cue; the camera pushes in on the picture', () => {
    const l = layoutScene(scene, { x: 0, y: 0, w: 1920, h: 1080 }, DEFAULT_THEME, newId)
    const frames = sceneFrames(3, 24)
    const m = sceneMotion(scene, l, words, frames, 24)
    const start = (i: number) => {
      const t = m.tracks[l.itemIds[i]!]!
      return (t.opacity ?? t.reveal)![0]!.frame
    }
    expect(start(0)).toBe(Math.round(0.1 * 24)) // first, no cue: right away
    expect(start(1)).toBe(Math.round(0.55 * 24)) // after the one before
    expect(start(2)).toBe(Math.round((VOICE_LEAD + 1.9 - 0.15) * 24)) // "makes electricity"
    expect(start(3)).toBe(Math.round((VOICE_LEAD + 0.8 - 0.15) * 24)) // first "panel"
    expect(m.tracks[l.itemIds[2]!]!.revealMode).toBe('typewriter')
    expect(m.tracks[l.itemIds[1]!]!.revealMode).toBe('draw')
    expect(m.tracks[l.itemIds[2]!]!.anchor).toMatchObject({ text: 'makes electricity', offset: -4, at: expect.any(Number) })
    expect(m.camera?.at(-1)?.value).toEqual({ x: 0, y: 0, zoom: PUSH_IN })
    // The words stay in the picture at the end of the push-in.
    const visibleLeft = 1920 / 2 - 1920 / 2 / PUSH_IN
    expect(Math.min(...l.items.filter((i) => i.kind !== 'asset').map((i) => i.x))).toBeGreaterThan(visibleLeft)
    expect(sceneMotion({ ...scene, zoom: false }, l, words, frames, 24).camera).toBeUndefined()
  })
})
