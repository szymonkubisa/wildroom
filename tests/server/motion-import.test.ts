import { mkdirSync, rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type AppDeps, closeDeps, createApp, createDeps } from '../../src/server/app'
import { loadEnv } from '../../src/server/env'
import { MemorySecretStore } from '../../src/server/services/keychain'
import { runFfmpeg } from '../../src/server/services/ffmpeg'
import type { MotionImportResult } from '../../src/shared/motion/importSchema'
import { layoutTimeline } from '../../src/shared/timeline/layout'
import type { ProjectDetail } from '../../src/shared/types/api'
import type { ServerEvent } from '../../src/shared/types/events'
import type { MotionClip } from '../../src/shared/types/project-doc'

const ORIGIN = 'http://127.0.0.1:5180'
const HOST = '127.0.0.1:5180'

let root: string
let deps: AppDeps
let app: ReturnType<typeof createApp>

function req(method: string, path: string, body?: unknown) {
  return app.request(`http://${HOST}${path}`, {
    method,
    headers: { host: HOST, ...(method !== 'GET' ? { origin: ORIGIN, 'x-studio': '1', 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

beforeAll(async () => {
  mkdirSync('tests/.tmp', { recursive: true })
  root = resolve(await mkdtemp(join('tests/.tmp', 'motion-import-')))
  deps = createDeps(loadEnv({ home: join(root, 'home'), port: 7781 }), { secrets: new MemorySecretStore() })
  app = createApp(deps)
})

afterAll(async () => {
  await closeDeps(deps)
  rmSync(root, { recursive: true, force: true })
})

describe('motion import', () => {
  it('builds boards, clips, voice-over and markers from one file, as one revision, and tells open editors', async () => {
    const project = (await (await req('POST', '/api/projects', { name: 'Imported explainer', settings: { width: 1280, height: 720 } })).json()) as ProjectDetail
    const dir = join(deps.env.tmpDir, 'import-fixtures')
    mkdirSync(dir, { recursive: true })
    const pic = join(dir, 'statue.png')
    const voice = join(dir, 'voice.wav')
    await runFfmpeg(['-f', 'lavfi', '-i', 'color=c=blue:s=64x64:d=0.1', '-frames:v', '1', pic])
    await runFfmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=3:sample_rate=48000', '-ac', '1', voice])
    const events: ServerEvent[] = []
    const stop = deps.events.subscribe((e) => events.push(e))

    const file = {
      version: 1,
      media: [
        { key: 'statue', path: pic },
        { key: 'vo', path: voice, role: 'dialogue', words: [{ text: 'Meet', start: 0.5, end: 0.8 }, { text: 'the', start: 0.8, end: 0.9 }, { text: 'triangle', start: 1, end: 1.6 }] },
      ],
      boards: [
        {
          name: 'Explainer',
          items: [
            { id: 'f1', kind: 'frame', name: 'Scene 1', x: 0, y: 0, w: 1280, h: 720, fill: '#101820' },
            { id: 'pic', kind: 'asset', assetId: '@@statue', x: 700, y: 100, w: 400, h: 400, frameId: 'f1', mask: 'ellipse' },
            { id: 'title', kind: 'text', text: 'The **triangle**', fontFamily: 'Inter', fontSize: 72, fontWeight: 700, color: '#ffffff', align: 'left', lineHeight: 1.1, x: 80, y: 200, w: 560, h: 90, frameId: 'f1' },
            { id: 'bogus', kind: 'sparkle', x: 0, y: 0, w: 1, h: 1 },
          ],
        },
      ],
      timeline: [
        {
          type: 'motion',
          key: 'scene1',
          board: 'Explainer',
          frame: 'Scene 1',
          duration: 96,
          tracks: { title: { opacity: [{ frame: 0, value: 0 }, { frame: 12, value: 1 }], anchor: { text: 'the triangle', offset: -2 } } },
        },
        { type: 'audio', key: 'voice', media: '@@vo', at: { clip: 'scene1', offset: 12 } },
      ],
      markers: [{ at: { clip: 'scene1', offset: 0 }, name: 'Scene 1', kind: 'chapter' }],
      brand: { name: 'Dare', colors: [{ hex: '#ff3366', role: 'primary' }] },
    }
    const res = await req('POST', `/api/projects/${project.id}/motion-import`, file)
    expect(res.status).toBe(200)
    const out = (await res.json()) as MotionImportResult
    stop()
    expect(Object.keys(out.assets)).toEqual(['statue', 'vo'])
    expect(out.warnings.join()).toMatch(/1 element/)
    expect(events).toContainEqual({ type: 'project.doc.saved', projectId: project.id, revision: out.revision, source: 'import' })

    const saved = (await (await req('GET', `/api/projects/${project.id}`)).json()) as ProjectDetail
    expect(saved.revision).toBe(out.revision)
    const board = saved.doc.canvas!.boards.find((b) => b.id === out.boards[0])!
    expect(board.items.map((i) => i.id)).toEqual(['f1', 'pic', 'title'])
    expect(board.items[1]).toMatchObject({ assetId: out.assets.statue, mask: 'ellipse' })
    const layout = layoutTimeline(saved.doc)
    const scene = layout.spine.find((s) => s.id === out.clips.scene1)!
    expect([scene.start, scene.end]).toEqual([0, 96])
    expect((scene.item as MotionClip).tracks.title!.anchor).toEqual({ text: 'the triangle', offset: -2, at: 0 })
    const vo = layout.connected.find((c) => c.id === out.clips.voice)!
    expect([vo.start, vo.lane]).toEqual([12, -1])
    expect(saved.doc.markers).toHaveLength(1)
    expect(saved.doc.brand?.name).toBe('Dare')
    // The voice's words came along, for captions and keys timed to them.
    const asset = deps.media.getDTO(out.assets.vo!)!
    expect(asset.alignment?.words.map((w) => w.text)).toEqual(['Meet', 'the', 'triangle'])
  }, 60_000)

  it('attaches Blender previs renders to story shots by label or number, and refuses an unknown shot', async () => {
    const project = (await (await req('POST', '/api/projects', { name: 'Previs test' })).json()) as ProjectDetail
    const story = {
      characters: [],
      places: [],
      // Two scenes, so shots are labelled "1.1", "1.2"…
      scenes: [
        { id: 'sc1', title: 'Alley' },
        { id: 'sc2', title: 'Office' },
      ],
      shots: [
        { id: 'a1', sceneId: 'sc1', prompt: 'A detective walks in.', duration: 3, characterIds: [], dialogue: [] },
        { id: 'a2', sceneId: 'sc1', prompt: 'He stops.', duration: 3, characterIds: [], dialogue: [] },
      ],
    }
    const put = await req('PUT', `/api/projects/${project.id}/doc`, { doc: { ...project.doc, story }, baseRevision: project.revision })
    expect(put.status).toBe(200)
    const dir = join(deps.env.tmpDir, 'previs-fixtures')
    mkdirSync(dir, { recursive: true })
    const layout = join(dir, 'layout.mp4')
    const depth = join(dir, 'depth.mp4')
    const first = join(dir, 'first.png')
    await runFfmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=320x176:r=24:d=1', '-pix_fmt', 'yuv420p', layout])
    await runFfmpeg(['-f', 'lavfi', '-i', 'color=c=gray:s=320x176:r=24:d=1', '-pix_fmt', 'yuv420p', depth])
    await runFfmpeg(['-f', 'lavfi', '-i', 'color=c=gray:s=320x176:d=0.1', '-frames:v', '1', first])
    const file = {
      version: 1,
      media: [
        { key: 'layout', path: layout },
        { key: 'depth', path: depth },
        { key: 'first', path: first },
      ],
      shots: [
        {
          shot: '1.2',
          previs: { layout: '@@layout', depth: '@@depth', firstFrame: '@@first', frames: 25, source: 'previs_test.blend · Cam2', figures: [{ color: 'blue', name: 'Ola' }] },
        },
        { shot: 1, previs: { layout: '@@layout' } },
      ],
    }
    const res = await req('POST', `/api/projects/${project.id}/motion-import`, file)
    expect(res.status).toBe(200)
    const out = (await res.json()) as MotionImportResult
    expect(out.shots).toEqual(['a2', 'a1'])
    const saved = (await (await req('GET', `/api/projects/${project.id}`)).json()) as ProjectDetail
    const [one, two] = saved.doc.story!.shots
    expect(one!.previs).toEqual({ assetId: out.assets.layout })
    expect(two!.previs).toEqual({
      assetId: out.assets.layout,
      depthAssetId: out.assets.depth,
      firstFrameAssetId: out.assets.first,
      frames: 25,
      source: 'previs_test.blend · Cam2',
      figures: [{ color: 'blue', name: 'Ola' }],
    })
    // An unknown shot, or a picture where the layout video goes, changes nothing.
    const bad = await req('POST', `/api/projects/${project.id}/motion-import`, { version: 1, shots: [{ shot: 9, previs: { layout: out.assets.layout } }] })
    expect(bad.status).toBe(400)
    const wrong = await req('POST', `/api/projects/${project.id}/motion-import`, { version: 1, shots: [{ shot: 1, previs: { layout: out.assets.first } }] })
    expect(wrong.status).toBe(400)
  }, 60_000)

  it('refuses files outside your folders, unknown placeholders and bad shapes, before changing anything', async () => {
    const project = (await (await req('POST', '/api/projects', { name: 'Refusals' })).json()) as ProjectDetail
    const post = (body: unknown) => req('POST', `/api/projects/${project.id}/motion-import`, body)
    const outside = await post({ media: [{ key: 'x', path: '/etc/hosts' }] })
    expect(outside.status).toBe(400)
    expect(((await outside.json()) as { error: string }).error).toMatch(/home folders/)
    const unknown = await post({ boards: [{ name: 'B', items: [{ id: 'a', kind: 'asset', assetId: '@@nope', x: 0, y: 0, w: 1, h: 1 }] }] })
    expect(((await unknown.json()) as { error: string }).error).toMatch(/@@nope/)
    const bad = await post({ timeline: [{ type: 'motion', board: 'B' }] })
    expect(bad.status).toBe(400)
    expect(JSON.stringify(await bad.json())).toMatch(/frame/)
    const after = (await (await req('GET', `/api/projects/${project.id}`)).json()) as ProjectDetail
    expect(after.revision).toBe(project.revision)
  })

  it('leaves none of its media in the project when it fails, and never answers "@@constructor"', async () => {
    const project = (await (await req('POST', '/api/projects', { name: 'Failed import' })).json()) as ProjectDetail
    const post = (body: unknown) => req('POST', `/api/projects/${project.id}/motion-import`, body)
    const dir = join(deps.env.tmpDir, 'import-fixtures-2')
    mkdirSync(dir, { recursive: true })
    const pic = join(dir, 'red.png')
    await runFfmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=32x32:d=0.1', '-frames:v', '1', pic])
    const media = [{ key: 'red', path: pic }]
    // A typo in a placeholder: refused before the picture is copied.
    const typo = await post({ media, boards: [{ name: 'B', items: [{ id: 'a', kind: 'asset', assetId: '@@rd', x: 0, y: 0, w: 1, h: 1 }] }] })
    expect(typo.status).toBe(400)
    const proto = await post({ boards: [{ name: 'B', items: [{ id: 'a', kind: 'asset', assetId: '@@constructor', x: 0, y: 0, w: 1, h: 1 }] }] })
    expect(((await proto.json()) as { error: string }).error).toMatch(/@@constructor/)
    // A clip on a frame that isn't there: refused after the picture was copied, which goes again.
    const late = await post({ media, timeline: [{ type: 'motion', board: 'missing', frame: 'f' }] })
    expect(late.status).toBe(400)
    expect(deps.media.list(project.id)).toEqual([])
  })
})
