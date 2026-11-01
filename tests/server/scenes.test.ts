import { mkdirSync, rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type AppDeps, closeDeps, createDeps } from '../../src/server/app'
import { loadEnv } from '../../src/server/env'
import { ApiError } from '../../src/server/http'
import { sceneRoutes } from '../../src/server/routes/scenes'
import { runFfmpeg } from '../../src/server/services/ffmpeg'
import { MemorySecretStore } from '../../src/server/services/keychain'
import { detectSceneCuts, mergeCuts, parseSceneScores, refineCuts, snapCuts } from '../../src/server/services/scenes'
import type { SceneCutsResponse } from '../../src/shared/types/scenes'

const FRAME = 1 / 24

/**
 * 5.75 s at 24 fps: near-black 1.5 s | near-white 2 s | mid grey 1.25 s | darker grey 1 s.
 * Hard cuts at 1.5 s and 3.5 s; the grey→grey cut at 4.75 s is subtle (scene score ≈ 0.27).
 */
const SEGMENTS: [string, number][] = [
  ['0x101010', 1.5],
  ['0xF0F0F0', 2],
  ['0x808080', 1.25],
  ['0x606060', 1],
]

let root: string
let clip: string
let still: string

beforeAll(async () => {
  mkdirSync('tests/.tmp', { recursive: true })
  root = await mkdtemp(join('tests/.tmp', 'scenes-'))
  clip = join(root, 'cuts.mp4')
  still = join(root, 'still.png')
  const inputs = SEGMENTS.flatMap(([color, seconds]) => ['-f', 'lavfi', '-i', `color=c=${color}:s=320x180:r=24:d=${seconds}`])
  const concat = `${SEGMENTS.map((_, i) => `[${i}:v]`).join('')}concat=n=${SEGMENTS.length}:v=1:a=0,format=yuv420p[v]`
  await runFfmpeg([...inputs, '-filter_complex', concat, '-map', '[v]', '-c:v', 'libx264', '-crf', '1', '-g', '12', '-bf', '0', clip])
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=c=0x336699:s=400x400:d=0.1', '-frames:v', '1', '-update', '1', still])
}, 60_000)

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('detectSceneCuts', () => {
  it('finds the hard cuts of a real clip', async () => {
    const cuts = await detectSceneCuts(clip)
    expect(cuts).toHaveLength(2)
    expect(cuts[0]).toBeCloseTo(1.5, 2)
    expect(cuts[1]).toBeCloseTo(3.5, 2)
  })

  it('finds subtler cuts with a lower threshold', async () => {
    const cuts = await detectSceneCuts(clip, { threshold: 0.15 })
    expect(cuts.map((c) => Math.round(c / FRAME))).toEqual([36, 84, 114]) // 1.5 s, 3.5 s, 4.75 s in frames
  })

  it('finds the subtle grey cut (≈0.27) at the storyboard’s threshold of 0.2, which ffmpeg’s 0.3 misses', async () => {
    // The storyboard's group takes (storyCuts.CUT_THRESHOLD): a missed cut put two shots in one piece.
    const cuts = await detectSceneCuts(clip, { threshold: 0.2 })
    expect(cuts.map((c) => Math.round(c / FRAME))).toEqual([36, 84, 114])
    expect(await detectSceneCuts(clip, { threshold: 0.3 })).toHaveLength(2)
  })

  it('reports times relative to the asset origin', async () => {
    const cuts = await detectSceneCuts(clip, { origin: 0.5 })
    expect(cuts[0]).toBeCloseTo(1, 2)
    expect(cuts[1]).toBeCloseTo(3, 2)
  })

  it('merges cuts closer than minGap', async () => {
    const cuts = await detectSceneCuts(clip, { threshold: 0.15, minGap: 1.3 })
    expect(cuts).toHaveLength(2)
    expect(cuts[0]).toBeCloseTo(1.5, 2)
    expect(cuts[1]).toBeCloseTo(3.5, 2) // 4.75 s merged into the stronger 3.5 s cut
  })

  it('parses metadata=print output and keeps the stronger of close cuts', () => {
    const stderr = [
      'Input #0, mov,mp4,m4a,3gp,3g2,mj2, from x.mp4:',
      '[Parsed_metadata_2 @ 0x1] frame:0    pts:18432   pts_time:1.5',
      '[Parsed_metadata_2 @ 0x1] lavfi.scene_score=0.410000',
      'frame=    0 fps=0.0 q=-0.0 size=       0kB time=00:00:00.00 bitrate=N/A speed=   0x    [Parsed_metadata_2 @ 0x1] frame:1    pts:19968   pts_time:1.625',
      '[Parsed_metadata_2 @ 0x1] lavfi.scene_score=0.950000',
      '[Parsed_metadata_2 @ 0x1] frame:2    pts:43008   pts_time:3.5',
      '[Parsed_metadata_2 @ 0x1] lavfi.scene_score=1.000000',
    ].join('\n')
    const scores = parseSceneScores(stderr)
    expect(scores).toEqual([
      { time: 1.5, score: 0.41 },
      { time: 1.625, score: 0.95 },
      { time: 3.5, score: 1 },
    ])
    expect(mergeCuts(scores, 0.4)).toEqual([1.625, 3.5])
    expect(mergeCuts(scores, 0)).toEqual([1.5, 1.625, 3.5])
  })
})

describe('refineCuts', () => {
  it('snaps expected cuts to the nearest detected cut within the tolerance', () => {
    expect(refineCuts([1.4, 3.9, 5], [1.5, 3.5, 3.6])).toEqual([1.5, 3.6, 5])
    expect(refineCuts([1.4, 3.9, 5], [1.5, 3.5], 0.3)).toEqual([1.5, 3.9, 5])
    expect(refineCuts([], [1, 2])).toEqual([])
    expect(refineCuts([2, 1], [])).toEqual([1, 2])
    expect(snapCuts([1.4, 3.9], [1.5], 0.5)).toEqual({ cuts: [1.5, 3.9], snapped: 1 })
  })

  it('refines planned cuts against a real clip', async () => {
    const detected = await detectSceneCuts(clip)
    const refined = refineCuts([1, 4], detected)
    expect(refined[0]).toBeCloseTo(1.5, 2)
    expect(refined[1]).toBeCloseTo(3.5, 2)
  })
})

describe('POST /assets/:id/scene-cuts', () => {
  let deps: AppDeps
  let app: Hono
  let videoId: string
  let plainVideoId: string
  let imageId: string

  const post = async (id: string, body?: unknown) => {
    const res = await app.request(`http://127.0.0.1/api/assets/${id}/scene-cuts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: res.status, json: (await res.json()) as SceneCutsResponse & { error?: string } }
  }

  beforeAll(async () => {
    deps = createDeps(loadEnv({ home: join(root, 'home'), port: 7791 }), { secrets: new MemorySecretStore() })
    const p1 = deps.registry.create({ name: 'Scenes' }).id
    app = new Hono()
    app.onError((err, c) =>
      err instanceof ApiError ? c.json({ error: err.message }, err.status) : c.json({ error: String(err) }, 500),
    )
    app.route('/api', sceneRoutes(deps))
    const multiShot = { shots: [], expectedCuts: [1.3, 3.8], auto: false }
    const video = await deps.media.importFile(clip, { name: 'Multi-shot', source: 'generation', projectId: p1, meta: { multiShot } })
    const plain = await deps.media.importFile(clip, { name: 'Plain', source: 'import', projectId: p1 })
    const image = await deps.media.importFile(still, { name: 'Still', source: 'import', projectId: p1 })
    videoId = video.id
    plainVideoId = plain.id
    imageId = image.id
    await Promise.all([videoId, plainVideoId, imageId].map((id) => deps.media.whenReady(id)))
    expect(deps.media.variantPath(deps.media.get(videoId)!, 'proxy')).toBeTruthy()
  }, 60_000)

  afterAll(async () => {
    if (deps) await closeDeps(deps)
  })

  it('refines the multi-shot plan stored on the asset', async () => {
    const { status, json } = await post(videoId)
    expect(status).toBe(200)
    expect(json.source).toBe('refined')
    expect(json.cuts).toHaveLength(2)
    expect(json.cuts[0]).toBeCloseTo(1.5, 2)
    expect(json.cuts[1]).toBeCloseTo(3.5, 2)
    expect(json.detected).toHaveLength(2)
  })

  it('uses expected cuts from the request, keeping the ones with no cut nearby', async () => {
    const { json } = await post(videoId, { expected: [2.6, 1.4, 99] })
    expect(json.source).toBe('refined')
    expect(json.cuts[0]).toBeCloseTo(1.5, 2)
    expect(json.cuts[1]).toBe(2.6)
    expect(json.cuts).toHaveLength(2) // 99 s is past the clip's end
    const none = await post(videoId, { expected: [2.6] })
    expect(none.json).toMatchObject({ source: 'expected', cuts: [2.6] })
  })

  it('falls back to scene detection without a plan', async () => {
    const { json } = await post(plainVideoId, {})
    expect(json.source).toBe('detected')
    expect(json.cuts.map((c) => Math.round(c / FRAME))).toEqual([36, 84])
    const lower = await post(plainVideoId, { threshold: 0.15 })
    expect(lower.json.cuts).toHaveLength(3)
    // As the storyboard asks for a group take's cuts.
    const storyboard = await post(plainVideoId, { expected: [], threshold: 0.2 })
    expect(storyboard.json).toMatchObject({ source: 'detected' })
    expect(storyboard.json.cuts.map((c) => Math.round(c / FRAME))).toEqual([36, 84, 114])
  })

  it('rejects images, unknown assets and bad bodies', async () => {
    expect((await post(imageId)).status).toBe(400)
    expect((await post('nope')).status).toBe(404)
    expect((await post(videoId, { expected: 'soon' })).status).toBe(400)
  })
})
