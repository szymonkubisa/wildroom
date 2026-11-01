import { describe, expect, it } from 'vitest'
import { mixColor, parseHex } from '../canvas/color'
import { pointAt } from '../canvas/path'
import { rescaleClipFrames } from '../timeline/fps'
import { cubicBezier, ease } from '../timeline/keyframes'
import { blade, setProps } from '../timeline/primitives'
import { insertAt } from '../timeline/compound'
import { layoutTimeline } from '../timeline/layout'
import { connectedAt, makeDoc, mclip, run } from '../timeline/test-utils'
import { mapMotionTime, trimHead } from '../timeline/util'
import { makeMotion } from '../timeline/factories'
import { type CanvasDoc, type CanvasFrameItem, type CanvasItem, sanitizeCanvas } from '../types/canvas'
import type { MotionClip } from '../types/project-doc'
import { PRESETS, applyPreset, cameraOn, cleanTrack, presetTrack, snapshotFrame, staggerTracks, trackValues, zoomToItem } from './edit'
import { MOTION_SAMPLES, type MotionItem, evaluateMotion, isMotionItem, motionAssetIds, motionSource, staticView } from './evaluate'
import { behaviorOffset, noise } from './behaviors'
import { fadeIn, fadeOut, mergeTracks, slideUpIn, stagger } from './presets'
import { sanitizeMotionClip, sanitizeMotionClips } from './sanitize'

const frame: CanvasFrameItem = { id: 'F', kind: 'frame', x: 100, y: 50, w: 1920, h: 1080, fill: '#102030' }
const items: CanvasItem[] = [
  frame,
  { id: 'S', kind: 'shape', shape: 'rect', fill: '#ff0000', x: 200, y: 150, w: 400, h: 200, frameId: 'F' },
  { id: 'T', kind: 'text', text: 'Hello', fontFamily: 'Inter', fontSize: 64, fontWeight: 700, color: '#fff', align: 'left', lineHeight: 1.2, x: 300, y: 500, w: 800, h: 80, frameId: 'F' },
  { id: 'I', kind: 'asset', assetId: 'img1', x: 1200, y: 300, w: 500, h: 500, frameId: 'F' },
  { id: 'N', kind: 'note', text: 'never drawn', color: 'yellow', x: 150, y: 100, w: 100, h: 100, frameId: 'F' },
  { id: 'OUT', kind: 'shape', shape: 'ellipse', fill: '#00f', x: 5000, y: 5000, w: 10, h: 10 },
]
const canvas: CanvasDoc = { boards: [{ id: 'B', name: 'Board', items }] }
let n = 0
const newId = () => `m${++n}`
const contents = items.filter((i) => i.frameId === 'F')

function motion(tracks: MotionClip['tracks'] = {}, extra: Partial<MotionClip> = {}): MotionClip {
  return { ...makeMotion({ duration: 120, newId, boardId: 'B', frameId: 'F', tracks }), ...extra }
}

describe('cubic-bezier easing', () => {
  it('matches the CSS curves at known points', () => {
    // CSS `ease` = cubic-bezier(0.25, 0.1, 0.25, 1): about 0.8024 at t = 0.5.
    expect(cubicBezier([0.25, 0.1, 0.25, 1], 0.5)).toBeCloseTo(0.8024, 3)
    expect(cubicBezier([0, 0, 1, 1], 0.37)).toBeCloseTo(0.37, 5)
    expect(cubicBezier([0.42, 0, 0.58, 1], 0.5)).toBeCloseTo(0.5, 5)
    expect(cubicBezier([0.34, 1.56, 0.64, 1], 0.6)).toBeGreaterThan(1) // overshoot
  })

  it('pins the ends and plugs into ease()', () => {
    expect(cubicBezier([0.9, 0.1, 0.1, 0.9], 0)).toBe(0)
    expect(cubicBezier([0.9, 0.1, 0.1, 0.9], 1)).toBe(1)
    expect(ease({ type: 'bezier', p: [0.42, 0, 1, 1] }, 0.5)).toBeCloseTo(cubicBezier([0.42, 0, 1, 1], 0.5), 9)
    expect(ease('ease-in', 0.5)).toBe(0.125)
  })
})

describe('motionSource', () => {
  it('takes the frame and its contents from the board', () => {
    const src = motionSource(motion(), canvas)
    expect(src.frame?.id).toBe('F')
    expect(src.items.map((i) => i.id)).toEqual(['S', 'T', 'I', 'N'])
  })

  it('has no frame when the board or the frame is gone, and prefers the detached snapshot', () => {
    expect(motionSource(motion({}, { frameId: 'nope' }), canvas).frame).toBeUndefined()
    expect(motionSource(motion(), undefined).frame).toBeUndefined()
    const detached = motion({}, { detached: [{ ...frame, fill: '#000' }, items[1]!] })
    const src = motionSource(detached, { boards: [] })
    expect(src.frame?.fill).toBe('#000')
    expect(src.items.map((i) => i.id)).toEqual(['S'])
  })
})

describe('evaluateMotion', () => {
  it('keeps elements without a track where the board has them, relative to the frame, notes left out', () => {
    const view = evaluateMotion(motion(), frame, contents, 30)
    expect(view.missing).toBe(false)
    expect(view.size).toEqual({ w: 1920, h: 1080 })
    expect(view.fill).toBe('#102030')
    expect(view.items.map((r) => r.item.id)).toEqual(['S', 'T', 'I'])
    expect(view.items[0]).toMatchObject({ rect: { x: 100, y: 100, w: 400, h: 200 }, scale: 1, rotation: 0, opacity: 1, reveal: 1 })
    expect(view.camera).toEqual({ x: 0, y: 0, zoom: 1 })
  })

  it('interpolates opacity and the offset transform with the keys’ easing', () => {
    const clip = motion({ S: slideUpIn({ at: 10, frames: 20, distance: 60 }) })
    const before = evaluateMotion(clip, frame, contents, 0).items[0]!
    expect(before.opacity).toBe(0)
    expect(before.rect.y).toBe(160)
    const mid = evaluateMotion(clip, frame, contents, 20).items[0]!
    expect(mid.opacity).toBeGreaterThan(0.5) // ease-out is past halfway at half time
    expect(mid.rect.y).toBeGreaterThan(100)
    expect(mid.rect.y).toBeLessThan(130)
    const after = evaluateMotion(clip, frame, contents, 30).items[0]!
    expect(after.opacity).toBe(1)
    expect(after.rect.y).toBe(100)
  })

  it('ignores tracks of deleted elements and reports a missing frame', () => {
    const clip = motion({ GONE: fadeIn({ at: 0, frames: 10 }) })
    expect(evaluateMotion(clip, frame, contents, 5).items).toHaveLength(3)
    const missing = evaluateMotion(clip, undefined, [], 5)
    expect(missing.missing).toBe(true)
    expect(missing.items).toEqual([])
  })

  it('moves the camera and plays from the clip’s offset', () => {
    const clip = motion({}, { camera: [{ frame: 0, value: { x: 0, y: 0, zoom: 1 } }, { frame: 40, value: { x: 200, y: -100, zoom: 2 } }] })
    expect(evaluateMotion(clip, frame, contents, 20).camera).toEqual({ x: 100, y: -50, zoom: 1.5 })
    expect(evaluateMotion({ ...clip, offset: 20 }, frame, contents, 0).camera).toEqual({ x: 100, y: -50, zoom: 1.5 })
  })

  it('clamps opacity and reveal into 0..1 (overshooting eases)', () => {
    const clip = motion({ T: { reveal: [{ frame: 0, value: 0, ease: { type: 'bezier', p: [0.3, 2, 0.6, 2] } }, { frame: 10, value: 1 }], revealMode: 'typewriter' } })
    const r = evaluateMotion(clip, frame, contents, 5).items[1]!
    expect(r.reveal).toBe(1)
    expect(r.revealMode).toBe('typewriter')
  })

  it('static view and asset ids', () => {
    expect(staticView(frame, contents).items.every((r) => r.opacity === 1)).toBe(true)
    expect(motionAssetIds(contents)).toEqual(['img1'])
  })
})

describe('presets', () => {
  it('stagger starts the same animation on each element in turn', () => {
    const tracks = stagger(['S', 'T', 'I'], 6, 8, (at) => fadeIn({ at, frames: 12 }))
    expect(Object.keys(tracks)).toEqual(['S', 'T', 'I'])
    expect(tracks.T!.opacity!.map((k) => k.frame)).toEqual([14, 26])
    expect(tracks.I!.opacity!.map((k) => k.frame)).toEqual([22, 34])
  })

  it('merges an entrance and an exit on one track', () => {
    const t = mergeTracks(fadeIn({ at: 0, frames: 10 }), fadeOut({ at: 100, frames: 10 }))
    expect(t.opacity!.map((k) => [k.frame, k.value])).toEqual([
      [0, 0],
      [10, 1],
      [100, 1],
      [110, 0],
    ])
  })
})

describe('motion time on the timeline', () => {
  it('blade: the right piece continues the animation (offset), keys stay put', () => {
    const clip = motion({ S: fadeIn({ at: 0, frames: 60 }) })
    const doc = run(makeDoc([mclip('A', 10), clip]), blade(clip.id, 40))
    const right = doc.spine[2] as MotionClip
    expect(right.kind).toBe('motion')
    expect(right.offset).toBe(30)
    expect(right.tracks.S!.opacity!.map((k) => k.frame)).toEqual([0, 60])
    const left = doc.spine[1] as MotionClip
    const at = (c: MotionClip, local: number) => evaluateMotion(c, frame, contents, local).items[0]!.opacity
    expect(at(right, 0)).toBeCloseTo(at(left, 29), 1)
  })

  it('head trims move the offset, frame-rate changes scale it with the keys', () => {
    const clip = motion({ S: fadeIn({ at: 10, frames: 20 }) })
    trimHead(clip, 12, 24)
    expect(clip.offset).toBe(12)
    expect(clip.duration).toBe(108)
    trimHead(clip, -12, 24)
    expect(clip.offset).toBeUndefined()
    const scaled = motion({ S: fadeIn({ at: 10, frames: 20 }) }, { offset: 12 })
    rescaleClipFrames(scaled, 2)
    expect(scaled.offset).toBe(24)
    expect(scaled.tracks.S!.opacity!.map((k) => k.frame)).toEqual([20, 60])
  })
})

describe('sanitizeMotionClip', () => {
  it('drops bad keys, clamps values and sorts', () => {
    const raw = {
      ...motion(),
      tracks: {
        S: {
          opacity: [{ frame: 20, value: 3 }, { frame: 'x', value: 1 }, { frame: 5.4, value: 0.5, ease: 'wobbly' }, { frame: 8, value: 0, ease: { type: 'bezier', p: [2, 0, -1, 1] } }],
          revealMode: 'explode',
          transform: [{ frame: 0, value: { x: 'a', y: 4, scale: -2 } }],
        },
        EMPTY: { opacity: 'no' },
      },
      camera: [{ frame: 0, value: { x: 1, y: 2, zoom: 0 } }],
      offset: 0,
    } as unknown as MotionClip
    const out = sanitizeMotionClip(raw)
    expect(Object.keys(out.tracks)).toEqual(['S'])
    expect(out.tracks.S!.opacity).toEqual([
      { frame: 5, value: 0.5 },
      { frame: 8, value: 0, ease: { type: 'bezier', p: [1, 0, 0, 1] } },
      { frame: 20, value: 1 },
    ])
    expect(out.tracks.S!.revealMode).toBeUndefined()
    expect(out.tracks.S!.transform).toEqual([{ frame: 0, value: { x: 0, y: 4, scale: 0, rotation: 0 } }])
    expect(out.camera).toEqual([{ frame: 0, value: { x: 1, y: 2, zoom: 0.05 } }])
    expect('offset' in out).toBe(false)
  })

  it('keeps a detached snapshot only when it starts with the frame, and fixes every timeline in place', () => {
    expect(sanitizeMotionClip(motion({}, { detached: [items[1]!] })).detached).toBeUndefined()
    expect(sanitizeMotionClip(motion({}, { detached: [frame, items[1]!] })).detached?.map((i) => i.id)).toEqual(['F', 'S'])
    const doc = makeDoc([{ ...motion(), tracks: { S: { opacity: [{ frame: 0, value: 9 }] } } }])
    sanitizeMotionClips(doc)
    expect((doc.spine[0] as MotionClip).tracks.S!.opacity![0]!.value).toBe(1)
  })
})

describe('editing (presets, scene, camera, detach)', () => {
  const clip = { offset: 0, duration: 120 }
  const shape = items[1] as MotionItem
  const text = items[2] as MotionItem

  it('places entrances after the clip starts and exits before it ends', () => {
    expect(presetTrack('fade-in', clip, { frames: 12, delay: 6 }, 1080).opacity!.map((k) => k.frame)).toEqual([6, 18])
    expect(presetTrack('fade-out', clip, { frames: 12, delay: 6 }, 1080).opacity!.map((k) => k.frame)).toEqual([102, 114])
    expect(presetTrack('slide-up-in', { offset: 30, duration: 60 }, { frames: 10, delay: 0 }, 1000).transform![0]).toMatchObject({ frame: 30, value: { y: 40 } })
    expect(presetTrack('words', clip, { frames: 10, delay: 0 }, 1080).revealMode).toBe('words')
  })

  it('a new entrance replaces the old one, an exit lives beside it', () => {
    let t = applyPreset(undefined, presetTrack('fade-in', clip, { frames: 10, delay: 0 }, 1080), 'in', clip)
    t = applyPreset(t, presetTrack('fade-out', clip, { frames: 10, delay: 0 }, 1080), 'out', clip)
    t = applyPreset(t, presetTrack('fade-in', clip, { frames: 20, delay: 5 }, 1080), 'in', clip)
    expect(t.opacity!.map((k) => k.frame)).toEqual([5, 25, 110, 120])
    t = applyPreset(t, presetTrack('slide-up-in', clip, { frames: 20, delay: 5 }, 1080), 'in', clip)
    expect(t.transform).toHaveLength(2)
    expect(cleanTrack({ opacity: [], revealMode: 'draw' })).toBeUndefined()
  })

  it('staggers only the elements a preset fits', () => {
    const tracks = staggerTracks({}, [shape, text], 'typewriter', clip, { frames: 12, delay: 4, step: 8 }, 1080)
    expect(Object.keys(tracks)).toEqual(['T'])
    expect(tracks.T!.reveal![0]!.frame).toBe(4)
    const all = staggerTracks({}, [shape, text], 'fade-in', clip, { frames: 12, delay: 4, step: 8 }, 1080)
    expect(all.T!.opacity![0]!.frame).toBe(12)
  })

  it('zooms the camera onto an element from where it is', () => {
    expect(cameraOn(frame, shape)).toEqual({ x: 400 - 1060, y: 250 - 590, zoom: Math.min(4, 0.7 * Math.min(1920 / 400, 1080 / 200)) })
    const keys = zoomToItem(undefined, frame, shape, 24, 36)
    expect(keys.map((k) => k.frame)).toEqual([24, 60])
    expect(keys[0]!.value).toEqual({ x: 0, y: 0, zoom: 1 })
    expect(keys[0]!.ease).toBeDefined()
  })

  it('reads track values and snapshots the frame for detaching', () => {
    expect(trackValues(undefined, 10)).toEqual({ opacity: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, reveal: 1, trim: { start: 0, end: 1 }, stretch: { x: 1, y: 1 }, blur: 0 })
    const snap = snapshotFrame(motionSource(motion(), canvas))!
    expect(snap.map((i) => i.id)).toEqual(['F', 'S', 'T', 'I', 'N'])
    expect(snap[0]).not.toBe(frame)
    expect(snapshotFrame({ items: [] })).toBeUndefined()
  })
})

describe('more animated properties', () => {
  it('overshoot, elastic and bounce start at 0 and land on 1; overshoot goes past', () => {
    for (const e of ['back', 'elastic', 'bounce'] as const) {
      expect(ease(e, 0)).toBeCloseTo(0, 9)
      expect(ease(e, 1)).toBeCloseTo(1, 9)
    }
    expect(Math.max(...[0.5, 0.6, 0.7, 0.8].map((t) => ease('back', t)))).toBeGreaterThan(1.05)
    expect(ease('bounce', 0.5)).toBeLessThan(1)
  })

  it('mixes colours in OKLab: red to blue stays saturated in the middle, alpha mixes too', () => {
    expect(mixColor('#ff0000', '#0000ff', 0)).toBe('#ff0000')
    expect(mixColor('#ff0000', '#0000ff', 1)).toBe('#0000ff')
    const mid = parseHex(mixColor('#ff0000', '#0000ff', 0.5))!
    expect(mid.r).toBeGreaterThan(100)
    expect(mid.b).toBeGreaterThan(100)
    // A purple, not a grey.
    expect(Math.min(mid.r, mid.b) - mid.g).toBeGreaterThan(40)
    expect(mixColor('#00000000', '#000000', 0.5)).toBe('#00000080')
  })

  it('resolves colour, stretch and blur keys; colour goes to text and to a solid fill', () => {
    const clip = motion({
      S: { color: [{ frame: 0, value: '#ff0000' }, { frame: 10, value: '#0000ff' }], stretch: [{ frame: 0, value: { x: 0, y: 1 } }, { frame: 10, value: { x: 1, y: 1 } }] },
      T: { color: [{ frame: 0, value: '#00ff00' }], blur: [{ frame: 0, value: 20 }, { frame: 10, value: 0 }] },
    })
    const at = (f: number) => evaluateMotion(clip, frame, contents, f).items
    const [s0, t0] = at(0)
    expect(s0!.item.kind === 'shape' && s0!.item.fill).toBe('#ff0000')
    expect(s0!.stretch).toEqual({ x: 0, y: 1 })
    expect(t0!.item.kind === 'text' && t0!.item.color).toBe('#00ff00')
    expect(t0!.blur).toBe(20)
    const [s10, t10] = at(10)
    expect(s10!.item.kind === 'shape' && s10!.item.fill).toBe('#0000ff')
    expect(s10!.stretch).toBeUndefined()
    expect(t10!.blur).toBeUndefined()
    expect(trackValues(clip.tracks.S, 5).stretch.x).toBeCloseTo(0.5, 6)
  })

  it('keeps the new keys through sanitizing and drops bad ones', () => {
    const clip = sanitizeMotionClip(
      motion({ S: { color: [{ frame: 0, value: 'red' as string }, { frame: 4, value: '#123456' }], blur: [{ frame: 0, value: -3 }], stretch: [{ frame: 0, value: { x: 2 } as never }] } }),
    )
    expect(clip.tracks.S).toEqual({ color: [{ frame: 4, value: '#123456' }], blur: [{ frame: 0, value: 0 }], stretch: [{ frame: 0, value: { x: 2, y: 1 } }] })
  })
})

describe('following a path', () => {
  it('finds the point and direction along an outline', () => {
    const line = [{ points: [[0, 0], [100, 0], [100, 100]] as [number, number][], closed: false }]
    expect(pointAt(line, 0)).toEqual({ x: 0, y: 0, angle: 0 })
    expect(pointAt(line, 0.25)).toEqual({ x: 50, y: 0, angle: 0 })
    expect(pointAt(line, 0.75)).toEqual({ x: 100, y: 50, angle: 90 })
    expect(pointAt(line, 1)).toEqual({ x: 100, y: 100, angle: 90 })
  })

  it('puts the element centre on the route, turned with it when asked', () => {
    const route: CanvasItem = { id: 'R', kind: 'shape', shape: 'line', points: [[0, 0.5], [1, 0.5]], fill: 'none', x: 600, y: 550, w: 1000, h: 100, frameId: 'F' }
    const all = [...contents, route]
    const clip = motion({ T: { follow: { pathId: 'R', progress: [{ frame: 0, value: 0 }, { frame: 10, value: 1 }], orient: true } } })
    const t = (f: number) => evaluateMotion(clip, frame, all, f).items.find((i) => i.item.id === 'T')!
    // T is 800×80: its centre goes from (600, 600) to (1600, 600) on the board, the frame starts at (100, 50).
    expect(t(0).rect).toEqual({ x: 600 - 400 - 100, y: 600 - 40 - 50, w: 800, h: 80 })
    expect(t(5).rect.x).toBe(1100 - 400 - 100)
    expect(t(10).rect.x).toBe(1600 - 400 - 100)
    expect(t(5).rotation).toBe(0)
    const turned = evaluateMotion(clip, frame, [...contents, { ...route, rotation: 90 }], 5).items.find((i) => i.item.id === 'T')!
    expect(turned.rotation).toBe(90)
    expect(turned.rect.x).toBeCloseTo(1100 - 400 - 100, 6)
    // The route deleted: the element stays where the board has it.
    expect(evaluateMotion(clip, frame, contents, 5).items.find((i) => i.item.id === 'T')!.rect.x).toBe(200)
  })
})

describe('motion blur and looks', () => {
  it('samples a moving element across the open shutter, and not a still one', () => {
    const moving = motion({ S: { motionBlur: 0.5, transform: [{ frame: 0, value: { x: 0, y: 0, scale: 1, rotation: 0 } }, { frame: 10, value: { x: 100, y: 0, scale: 1, rotation: 0 } }] } })
    const s = evaluateMotion(moving, frame, contents, 5).items[0]!
    expect(s.trail).toHaveLength(MOTION_SAMPLES)
    expect(s.trail![0]!.rect.x).toBeCloseTo(s.rect.x - 2.5, 6)
    expect(s.trail!.at(-1)!.rect.x).toBeCloseTo(s.rect.x + 2.5, 6)
    expect(evaluateMotion(moving, frame, contents, 20).items[0]!.trail).toBeUndefined()
  })

  it('keeps shadow, glow and blend on drawn elements only', () => {
    const doc = sanitizeCanvas({
      boards: [
        {
          id: 'B',
          name: 'B',
          items: [
            { id: 'S', kind: 'shape', shape: 'rect', fill: '#fff', x: 0, y: 0, w: 10, h: 10, shadow: { color: '#000', blur: 4, x: 1, y: 2 }, glow: { color: '#0ff', blur: 6, x: 9 }, blend: 'screen' },
            { id: 'N', kind: 'note', text: '', color: 'yellow', x: 0, y: 0, w: 10, h: 10, blend: 'screen', shadow: { color: '#000', blur: 4 } },
            { id: 'T', kind: 'text', text: 'a', fontFamily: 'Inter', fontSize: 10, fontWeight: 400, color: '#fff', align: 'left', lineHeight: 1, x: 0, y: 0, w: 10, h: 10, blend: 'nope' },
          ],
        },
      ],
    } as never)!
    const [s, n, t] = doc.boards[0]!.items
    expect(s).toMatchObject({ shadow: { color: '#000', blur: 4, x: 1, y: 2 }, glow: { color: '#0ff', blur: 6 }, blend: 'screen' })
    expect(s!.glow).not.toHaveProperty('x')
    expect(n).not.toHaveProperty('blend')
    expect(n).not.toHaveProperty('shadow')
    expect(t).not.toHaveProperty('blend')
  })
})

describe('behaviours and loops', () => {
  it('noise is repeatable, smooth and within -1..1', () => {
    expect(noise(3.3, 7)).toBe(noise(3.3, 7))
    expect(noise(3.3, 7)).not.toBe(noise(3.3, 8))
    expect(Math.abs(noise(3.5, 7) - noise(3.51, 7))).toBeLessThan(0.05)
    for (let u = 0; u < 50; u += 0.37) expect(Math.abs(noise(u, 3))).toBeLessThanOrEqual(1)
  })

  it('float, spin, orbit and pulse follow their period; ranges ease in and out', () => {
    expect(behaviorOffset([{ kind: 'float', amount: 10, period: 40 }], 10).y).toBeCloseTo(10, 6)
    expect(behaviorOffset([{ kind: 'spin', amount: 360, period: 48 }], 24).rotation).toBeCloseTo(180, 6)
    expect(behaviorOffset([{ kind: 'orbit', amount: 5, period: 20 }], 5)).toMatchObject({ x: expect.closeTo(0, 6), y: expect.closeTo(5, 6) })
    expect(behaviorOffset([{ kind: 'pulse', amount: 0.1, period: 20 }], 10).scale).toBeCloseTo(1.1, 6)
    const ranged = { kind: 'float' as const, amount: 10, period: 40, from: 100, to: 200 }
    expect(behaviorOffset([ranged], 50).y).toBe(0)
    expect(behaviorOffset([ranged], 103).y).toBeCloseTo(0.5 * 10 * Math.sin((2 * Math.PI * 103) / 40), 6)
    expect(behaviorOffset([ranged], 250).y).toBe(0)
    // A ranged spin starts from 0°, speeds up over its ramp, and holds its last angle after `to`.
    const spin = { kind: 'spin' as const, amount: 360, period: 24, from: 100, to: 148 }
    expect(behaviorOffset([spin], 100).rotation).toBe(0)
    expect(behaviorOffset([spin], 106).rotation).toBeCloseTo(45, 6) // 3 frames on, of 24 a turn
    expect(behaviorOffset([spin], 148).rotation).toBeCloseTo(630, 6)
    expect(behaviorOffset([spin], 300).rotation).toBeCloseTo(630, 6)
  })

  it('adds behaviours to the keys and repeats looped keys', () => {
    const clip = motion({
      S: { behaviors: [{ kind: 'float', amount: 10, period: 40 }] },
      T: { opacity: [{ frame: 0, value: 0 }, { frame: 10, value: 1 }], loop: { from: 0, to: 10 } },
    })
    const at = (f: number) => evaluateMotion(clip, frame, contents, f).items
    expect(at(10)[0]!.rect.y).toBeCloseTo(150 - 50 + 10, 6)
    expect(at(15)[1]!.opacity).toBeCloseTo(0.5, 6)
    expect(at(25)[1]!.opacity).toBeCloseTo(0.5, 6)
    expect(cleanTrack({ behaviors: [{ kind: 'spin', amount: 360, period: 24 }] })).toEqual({ behaviors: [{ kind: 'spin', amount: 360, period: 24 }] })
  })

  it('sanitizes behaviours and loops, and retimes them with the clip', () => {
    const clip = sanitizeMotionClip(
      motion({ S: { behaviors: [{ kind: 'boing', amount: 1, period: 2 } as never, { kind: 'wiggle', amount: 5, period: 0.4, from: 2.6 }], loop: { from: 10, to: 5 } } }),
    )
    expect(clip.tracks.S).toEqual({ behaviors: [{ kind: 'wiggle', amount: 5, period: 1, from: 3 }] })
    const retimed = motion({ S: { behaviors: [{ kind: 'float', amount: 5, period: 24, from: 12 }], loop: { from: 0, to: 24 } } })
    mapMotionTime(retimed, (f) => f * 2)
    expect(retimed.tracks.S).toEqual({ behaviors: [{ kind: 'float', amount: 5, period: 48, from: 24 }], loop: { from: 0, to: 48 } })
  })
})

describe('more presets', () => {
  const clip = motion()
  const timing = { frames: 12, delay: 0 }
  const text = contents.find((i) => i.id === 'T') as MotionItem

  it('every preset writes something on an element it fits', () => {
    for (const p of PRESETS) {
      const track = presetTrack(p.id, clip, timing, 1080, { item: text, routeId: 'S' })
      expect(Object.keys(track).length, p.id).toBeGreaterThan(0)
    }
  })

  it('word presets take longer for longer text; exits end before the clip does', () => {
    const long = { ...text, text: 'one two three four five six seven eight nine ten' } as MotionItem
    const keys = presetTrack('words-rise', clip, timing, 1080, { item: long }).reveal!
    expect(keys.at(-1)!.frame - keys[0]!.frame).toBe(Math.round(12 * 0.35 * 10))
    const fly = presetTrack('fly-out', clip, timing, 1080)
    expect(fly.transform!.at(-1)!.frame).toBe(120)
    expect(fly.motionBlur).toBe(0.5)
  })

  it('a behaviour preset replaces one of its kind and keeps the keys', () => {
    let track = applyPreset(fadeIn({ at: 0, frames: 10 }), presetTrack('shake', clip, timing, 1080), 'in', clip)
    track = applyPreset(track, presetTrack('shake', clip, { frames: 20, delay: 5 }, 1080), 'in', clip)
    track = applyPreset(track, presetTrack('float', clip, timing, 1080), 'in', clip)
    expect(track.behaviors!.map((b) => [b.kind, b.from])).toEqual([
      ['shake', 5],
      ['float', undefined],
    ])
    expect(track.opacity).toHaveLength(2)
  })

  it('staggers a route preset onto everything but the route', () => {
    const tracks = staggerTracks({}, contents.filter(isMotionItem), 'follow-path', clip, { frames: 12, delay: 0, step: 6 }, 1080)
    expect(Object.keys(tracks).sort()).toEqual(['I', 'T'])
    expect(tracks.T!.follow!.pathId).toBe('S')
  })
})

describe('groups in motion', () => {
  // S (400×200 at 200,150) and T (800×80 at 300,500) in a group G: its box is 200,150 → 1100,580.
  const G: CanvasItem = { id: 'G', kind: 'group', x: 200, y: 150, w: 900, h: 430, frameId: 'F' }
  const grouped = [...contents.map((i) => (i.id === 'S' || i.id === 'T' ? { ...i, groupId: 'G' } : i)), G]

  it('moves members with the group and fades them with it', () => {
    const clip = motion({ G: { opacity: [{ frame: 0, value: 0.5 }], transform: [{ frame: 0, value: { x: 100, y: 0, scale: 1, rotation: 0 } }] }, S: { opacity: [{ frame: 0, value: 0.5 }] } })
    const [s, t] = evaluateMotion(clip, frame, grouped, 0).items
    expect(s!.rect.x).toBe(200 - 100 + 100)
    expect(s!.opacity).toBe(0.25)
    expect(t!.rect.x).toBe(300 - 100 + 100)
    expect(t!.groupIds).toEqual(['G'])
  })

  it('turns and scales members around the group centre', () => {
    const clip = motion({ G: { transform: [{ frame: 0, value: { x: 0, y: 0, scale: 2, rotation: 90 } }] } })
    const s = evaluateMotion(clip, frame, grouped, 0).items[0]!
    // S's centre (400, 250) is (-250, -115) from the group centre (650, 365): ×2 and a quarter turn → (230, -500).
    expect(s.rect.x + s.rect.w / 2 + frame.x).toBeCloseTo(650 + 230, 6)
    expect(s.rect.y + s.rect.h / 2 + frame.y).toBeCloseTo(365 - 500, 6)
    expect(s.rotation).toBe(90)
    expect(s.scale).toBe(2)
  })

  it('a group behaviour and motion blur reach its members', () => {
    const clip = motion({ G: { behaviors: [{ kind: 'float', amount: 10, period: 40 }], motionBlur: 0.5 } })
    expect(evaluateMotion(clip, frame, grouped, 10).items[0]!.rect.y).toBeCloseTo(150 - 50 + 10, 6)
    // Fastest as it passes the middle: blurred there.
    expect(evaluateMotion(clip, frame, grouped, 0).items[0]!.trail).toHaveLength(MOTION_SAMPLES)
  })
})

describe('clipping masks', () => {
  it('a mask is not drawn on its own; what it clips knows its mask, from itself or its group', () => {
    const G: CanvasItem = { id: 'G', kind: 'group', x: 300, y: 500, w: 800, h: 80, frameId: 'F', clipBy: 'S', clipInvert: true }
    const list = [...contents.map((i) => (i.id === 'T' ? { ...i, groupId: 'G' } : i.id === 'I' ? { ...i, clipBy: 'S' } : i)), G]
    const [s, t, img] = evaluateMotion(motion(), frame, list, 0).items
    expect(s!.matte).toBe(true)
    expect(img!.clip).toEqual({ by: 'S', invert: false })
    expect(t!.clip).toEqual({ by: 'S', invert: true })
    expect(t!.matte).toBeUndefined()
  })

  it('drops masks that point at nothing, at itself, a frame or a note', () => {
    const doc = sanitizeCanvas({
      boards: [
        {
          id: 'B',
          name: 'B',
          items: [
            { id: 'F', kind: 'frame', x: 0, y: 0, w: 10, h: 10 },
            { id: 'N', kind: 'note', text: '', color: 'yellow', x: 0, y: 0, w: 10, h: 10 },
            { id: 'a', kind: 'shape', shape: 'rect', fill: '#fff', x: 0, y: 0, w: 10, h: 10, clipBy: 'b', clipInvert: true },
            { id: 'b', kind: 'shape', shape: 'rect', fill: '#fff', x: 0, y: 0, w: 10, h: 10, clipBy: 'b' },
            { id: 'c', kind: 'shape', shape: 'rect', fill: '#fff', x: 0, y: 0, w: 10, h: 10, clipBy: 'F', clipInvert: true },
            { id: 'd', kind: 'shape', shape: 'rect', fill: '#fff', x: 0, y: 0, w: 10, h: 10, clipBy: 'N' },
          ],
        },
      ],
    } as never)!
    const by = new Map(doc.boards[0]!.items.map((i) => [i.id, i]))
    expect(by.get('a')).toMatchObject({ clipBy: 'b', clipInvert: true })
    for (const id of ['b', 'c', 'd']) {
      expect(by.get(id)).not.toHaveProperty('clipBy')
      expect(by.get(id)).not.toHaveProperty('clipInvert')
    }
  })
})

describe('hidden layers', () => {
  it('hidden elements and members of hidden groups are not drawn, unless they are a mask', () => {
    const G: CanvasItem = { id: 'G', kind: 'group', x: 300, y: 500, w: 800, h: 80, frameId: 'F', hidden: true }
    const list = [...contents.map((i) => (i.id === 'T' ? { ...i, groupId: 'G' } : i.id === 'S' ? { ...i, hidden: true } : i)), G]
    expect(evaluateMotion(motion(), frame, list, 0).items.map((r) => r.item.id)).toEqual(['I'])
    const masked = list.map((i) => (i.id === 'I' ? { ...i, clipBy: 'S' } : i))
    const drawn = evaluateMotion(motion(), frame, masked, 0).items
    expect(drawn.map((r) => [r.item.id, Boolean(r.matte)])).toEqual([
      ['S', true],
      ['I', false],
    ])
  })
})

describe('timeline overlays and progress', () => {
  it('an overlay covers the whole timeline, above everything, through edits', () => {
    let doc = makeDoc([mclip('A', 24), mclip('B', 36)])
    const other = { ...motion(), id: 'other', duration: 10 }
    const overlay = { ...motion(), id: 'ov', duration: 5, span: 'timeline' as const }
    doc.connected = [connectedAt(doc, other, 10, 3), connectedAt(doc, overlay, 30, 1)]
    doc = run(doc, () => {})
    const ov = () => layoutTimeline(doc).connected.find((c) => c.id === 'ov')!
    expect([ov().start, ov().end]).toEqual([0, 60])
    expect(doc.connected.find((c) => c.id === 'ov')!.lane).toBe(4)
    // The storyline grows: so does the overlay.
    doc = run(doc, insertAt(24, [mclip('C', 12)]))
    expect([ov().start, ov().end]).toEqual([0, 72])
    // Taking it off the whole timeline keeps it where it is.
    doc = run(doc, setProps('ov', { span: null }))
    expect(ov().end).toBe(72)
    // Only connected clips can cover the timeline.
    const spineMotion = { ...motion(), id: 'sm', duration: 10 }
    const d2 = run(makeDoc([spineMotion]), setProps('sm', { span: 'timeline' }))
    expect((d2.spine[0] as MotionClip).span).toBeUndefined()
  })

  it('a bar fills with the clip, an outline draws on with it', () => {
    const clip = { ...motion({ S: { progress: 'reveal' }, T: { progress: 'trim' } }), duration: 101 }
    const at = (f: number) => evaluateMotion(clip, frame, contents, f).items
    expect(at(0)[0]).toMatchObject({ reveal: 0, revealMode: 'wipe-left' })
    expect(at(50)[0]!.reveal).toBeCloseTo(0.5, 9)
    expect(at(100)[0]!.reveal).toBe(1)
    expect(at(25)[1]!.trim).toEqual({ start: 0, end: 0.25 })
    expect(cleanTrack({ progress: 'reveal', revealMode: 'wipe-up' })).toEqual({ progress: 'reveal', revealMode: 'wipe-up' })
  })
})
