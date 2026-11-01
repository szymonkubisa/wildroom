import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadEnv } from '../../src/server/env'
import { EventBus } from '../../src/server/services/events'
import { AppState } from '../../src/server/storage/appState'
import { BundleGoneError, listRecordFiles, readJsonFile, writeJsonSync } from '../../src/server/storage/atomicFile'
import { acquireLock } from '../../src/server/storage/lock'
import { ProjectFormatError } from '../../src/server/storage/projectStore'
import {
  type AssetRecord,
  type GenerationRecord,
  normalizeAssetRecord,
  type ProjectFile,
  recordToGeneration,
} from '../../src/server/storage/records'
import { ProjectRegistry } from '../../src/server/storage/registry'
import { reidentifyBundle, remapJson, replayReidentify } from '../../src/server/storage/reidentify'
import type { ServerEvent } from '../../src/shared/types/events'

let root: string

beforeAll(async () => {
  mkdirSync('tests/.tmp', { recursive: true })
  root = resolve(await mkdtemp(join('tests/.tmp', 'storage-')))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

/** A registry over its own app home, with the events it published. */
function setup(name: string) {
  const env = loadEnv({ home: join(root, name) })
  const events = new EventBus()
  const seen: ServerEvent[] = []
  events.subscribe((e) => seen.push(e))
  const appState = new AppState(env)
  const registry = new ProjectRegistry({ env, appState, events })
  return { env, seen, appState, registry }
}

/** A lock file as another Mac writes it (opened there, or taken over with "Open anyway"). */
function foreignLock(bundle: string) {
  writeFileSync(join(bundle, '.lock'), JSON.stringify({ pid: 4242, startedAt: new Date().toISOString(), host: 'other-mac', machineId: 'm_other' }))
}

describe('atomic files', () => {
  it('never re-creates a vanished bundle', () => {
    const bundle = join(root, 'Gone.wildroom')
    expect(() => writeJsonSync(join(bundle, 'Assets', 'a.json'), { id: 'a' }, { root: bundle })).toThrow(BundleGoneError)
    expect(existsSync(bundle)).toBe(false)
  })

  it('never writes outside the root it is given', () => {
    const bundle = join(root, 'Contained.wildroom')
    mkdirSync(join(bundle, 'Assets'), { recursive: true })
    for (const path of [join(bundle, 'Assets', '../../escaped.json'), join(root, 'escaped.json'), bundle]) {
      expect(() => writeJsonSync(path, { id: 'x' }, { root: bundle })).toThrow(/outside/)
    }
    expect(existsSync(join(root, 'escaped.json'))).toBe(false)
    // Inside it (also a name that merely starts with dots) is fine.
    writeJsonSync(join(bundle, '..dots.json'), {}, { root: bundle })
    writeJsonSync(join(bundle, 'Assets', 'a.json'), { id: 'a' }, { root: bundle })
    expect(readdirSync(join(bundle, 'Assets'))).toEqual(['a.json'])
  })

  it('lists record files, skipping temp files, AppleDouble files and sync-conflict copies', () => {
    const dir = join(root, 'records')
    mkdirSync(dir, { recursive: true })
    for (const name of ['abc.json', 'X_y-1.json', '._abc.json', '.abc.json.tmp-1.nosync', 'abc 2.json', 'abc (conflicted copy).json', 'notes.txt']) {
      writeFileSync(join(dir, name), '{}')
    }
    expect(listRecordFiles(dir).sort()).toEqual(['X_y-1.json', 'abc.json'])
  })
})

describe('re-identifying a copied bundle', () => {
  function makeBundle(name: string) {
    const bundle = join(root, `${name}.wildroom`)
    for (const dir of ['Assets', 'Generations', 'Media']) mkdirSync(join(bundle, dir), { recursive: true })
    const now = new Date().toISOString()
    const project = {
      app: 'wildroom',
      format: 1,
      id: 'proj000001',
      name,
      createdAt: now,
      updatedAt: now,
      revision: 7,
      summary: { durationFrames: 10, posterAssetId: 'asset-one-aaaaaaaaaaaa' },
      doc: {
        spine: [{ takes: [{ assetId: 'asset-one-aaaaaaaaaaaa', generationId: 'gen-done-111' }] }],
        // Not an id of this bundle (substring / external): untouched.
        note: 'see asset-one-aaaaaaaaaaaa-old',
        story: { voiceId: 'external-voice' },
      },
    }
    writeJsonSync(join(bundle, 'project.json'), project)
    writeJsonSync(join(bundle, 'Assets', 'asset-one-aaaaaaaaaaaa.json'), { id: 'asset-one-aaaaaaaaaaaa', generationId: 'gen-done-111', parentIds: [] })
    writeJsonSync(join(bundle, 'Generations', 'gen-done-111.json'), { id: 'gen-done-111', status: 'succeeded', outputAssetIds: ['asset-one-aaaaaaaaaaaa'] })
    writeJsonSync(join(bundle, 'Generations', 'gen-run-2222.json'), { id: 'gen-run-2222', status: 'running', providerTaskId: 'task-1' })
    return bundle
  }

  it('gives every own id a new value, references included, and cancels unfinished jobs', () => {
    const bundle = makeBundle('Copy')
    const { projectId, map } = reidentifyBundle(bundle, { name: 'Copy (2)' })
    const project = readJsonFile<ProjectFile & { doc: Record<string, unknown> }>(join(bundle, 'project.json'))!.value
    expect(project.id).toBe(projectId)
    expect(project.name).toBe('Copy (2)')
    expect(project.revision).toBe(1)
    const asset = map['asset-one-aaaaaaaaaaaa']!
    const done = map['gen-done-111']!
    const running = map['gen-run-2222']!
    expect(project.summary.posterAssetId).toBe(asset)
    expect(project.doc).toMatchObject({
      spine: [{ takes: [{ assetId: asset, generationId: done }] }],
      note: 'see asset-one-aaaaaaaaaaaa-old',
      story: { voiceId: 'external-voice' },
    })
    expect(readdirSync(join(bundle, 'Assets'))).toEqual([`${asset}.json`])
    expect(readdirSync(join(bundle, 'Generations')).sort()).toEqual([`${done}.json`, `${running}.json`].sort())
    expect(readJsonFile<AssetRecord>(join(bundle, 'Assets', `${asset}.json`))!.value).toMatchObject({ id: asset, generationId: done })
    expect(readJsonFile<GenerationRecord>(join(bundle, 'Generations', `${done}.json`))!.value).toMatchObject({ status: 'succeeded', outputAssetIds: [asset] })
    expect(readJsonFile<GenerationRecord>(join(bundle, 'Generations', `${running}.json`))!.value).toMatchObject({
      status: 'canceled',
      providerTaskId: 'task-1',
      error: { code: 'canceled' },
    })
    expect(existsSync(join(bundle, '.reidentify.json'))).toBe(false)
  })

  it('finishes an interrupted run from its journal', () => {
    const bundle = makeBundle('Crashed')
    const map = { proj000001: 'proj000002', 'asset-one-aaaaaaaaaaaa': 'asset-new-bbbbbbbbbbbb', 'gen-done-111': 'gen-new-3333', 'gen-run-2222': 'gen-new-4444' }
    writeJsonSync(join(bundle, '.reidentify.json'), { map, at: new Date().toISOString() })
    // Crashed after writing one new record.
    writeJsonSync(join(bundle, 'Assets', 'asset-new-bbbbbbbbbbbb.json'), { id: 'asset-new-bbbbbbbbbbbb' })
    replayReidentify(bundle)
    expect(readJsonFile<ProjectFile>(join(bundle, 'project.json'))!.value.id).toBe('proj000002')
    expect(readdirSync(join(bundle, 'Assets'))).toEqual(['asset-new-bbbbbbbbbbbb.json'])
    expect(readdirSync(join(bundle, 'Generations')).sort()).toEqual(['gen-new-3333.json', 'gen-new-4444.json'])
    expect(existsSync(join(bundle, '.reidentify.json'))).toBe(false)
  })

  it('refuses a crafted journal: nothing outside the bundle is written or deleted', () => {
    const bundle = makeBundle('Crafted')
    const victimDir = join(root, 'victim-dir')
    mkdirSync(victimDir, { recursive: true })
    writeFileSync(join(victimDir, 'settings.json'), '{"keep":true}')
    // A bundle someone sent, with a journal that points its "new ids" out of the bundle.
    const map = { proj000001: 'proj000002', 'asset-one-aaaaaaaaaaaa': '../../victim-dir/settings', 'gen-done-111': 'gen-new-3333' }
    writeJsonSync(join(bundle, '.reidentify.json'), { map, at: new Date().toISOString() })
    expect(() => replayReidentify(bundle)).toThrow(ProjectFormatError)
    expect(readFileSync(join(victimDir, 'settings.json'), 'utf8')).toBe('{"keep":true}')
    expect(readdirSync(victimDir)).toEqual(['settings.json'])
    // The bundle is as it was, minus the journal.
    expect(readdirSync(join(bundle, 'Assets'))).toEqual(['asset-one-aaaaaaaaaaaa.json'])
    expect(readJsonFile<ProjectFile>(join(bundle, 'project.json'))!.value.id).toBe('proj000001')
    expect(existsSync(join(bundle, '.reidentify.json'))).toBe(false)

    // Opening such a bundle is refused as unreadable (not a server error).
    writeJsonSync(join(bundle, '.reidentify.json'), { map: { proj000001: '../../../escaped' }, at: new Date().toISOString() })
    const { registry } = setup('crafted-journal-home')
    expect(() => registry.open(bundle)).toThrow(expect.objectContaining({ status: 422, details: { code: 'unreadable' } }))
    expect(existsSync(join(root, 'escaped.json'))).toBe(false)
  })

  it('never takes an inherited property for a mapped id', () => {
    const bundle = makeBundle('Inherited')
    writeJsonSync(join(bundle, 'Assets', 'constructor.json'), { id: 'constructor' })
    const map = { proj000001: 'proj000003', 'asset-one-aaaaaaaaaaaa': 'asset-new-cccccccccccc', 'gen-done-111': 'gen-new-5555', 'gen-run-2222': 'gen-new-6666' }
    writeJsonSync(join(bundle, '.reidentify.json'), { map, at: new Date().toISOString() })
    replayReidentify(bundle)
    expect(readdirSync(join(bundle, 'Assets')).sort()).toEqual(['asset-new-cccccccccccc.json', 'constructor.json'])
  })

  it('remaps exact values and keys only', () => {
    expect(remapJson({ a: ['x', 'xy', { x: 'x' }] }, { x: 'z' })).toEqual({ a: ['z', 'xy', { z: 'z' }] })
  })
})

describe('external changes to an open project', () => {
  it('keeps the other version of project.json in Conflicts/', () => {
    const env = loadEnv({ home: join(root, 'conflict-home') })
    const events = new EventBus()
    const seen: ServerEvent[] = []
    events.subscribe((e) => seen.push(e))
    const registry = new ProjectRegistry({ env, appState: new AppState(env), events })
    const store = registry.create({ name: 'Shared' })
    // Another machine (via a sync service) rewrites project.json.
    const path = join(store.root, 'project.json')
    const theirs = { ...readJsonFile<ProjectFile>(path)!.value, name: 'Their edit' }
    writeFileSync(path, JSON.stringify(theirs))
    store.saveDoc(store.project.doc, store.project.revision, store.project.summary)
    const conflicts = readdirSync(join(store.root, 'Conflicts'))
    expect(conflicts).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(store.root, 'Conflicts', conflicts[0]!), 'utf8')).name).toBe('Their edit')
    expect(seen.some((e) => e.type === 'project.conflict' && e.projectId === store.id)).toBe(true)
    // Ours stays authoritative, and a backup sits outside the bundle.
    expect(readJsonFile<ProjectFile>(path)!.value.name).toBe('Shared')
    expect(readdirSync(join(env.appDataDir, 'Backups', store.id)).length).toBeGreaterThan(0)
    registry.closeAll()
  })
})

describe('bundles that share asset ids without being copies', () => {
  it('gives only the shared assets new ids: the project keeps its id and its jobs', () => {
    const { registry } = setup('shared-ids-home')
    const now = new Date().toISOString()
    const shared = normalizeAssetRecord({ id: 'shared-asset-000000001', kind: 'image', name: 'Shared', source: 'import', createdAt: now } as AssetRecord)
    const a = registry.create({ name: 'A' })
    a.putAsset(shared, 'now')
    registry.indexAsset(a, shared.id)
    const b = registry.create({ name: 'B' })
    const bRoot = b.root
    const bId = b.id
    b.putAsset({ ...shared, parentIds: [] }, 'now')
    b.putGeneration(
      recordToGeneration(
        { id: 'gen-b-running', status: 'running', providerTaskId: 'task-b', params: { image: shared.id }, outputAssetIds: [] } as unknown as GenerationRecord,
        bId,
      ),
      'now',
    )
    b.saveDoc({ ...b.project.doc, spine: [{ kind: 'media', takes: [{ assetId: shared.id }] }] } as never, b.project.revision, b.project.summary)
    registry.close(bId)

    const reopened = registry.open(bRoot)
    expect(reopened.id).toBe(bId)
    const [newId] = [...reopened.assets.keys()]
    expect(newId).not.toBe(shared.id)
    expect(registry.assetOwner(shared.id)).toBe(a)
    expect(registry.assetOwner(newId!)).toBe(reopened)
    const job = reopened.generations.get('gen-b-running')!
    expect(job.status).toBe('running')
    expect(JSON.parse(job.paramsJson)).toEqual({ image: newId })
    expect((reopened.project.doc as unknown as { spine: Array<{ takes: Array<{ assetId: string }> }> }).spine[0]!.takes[0]!.assetId).toBe(newId)
    expect(existsSync(join(bRoot, '.reidentify.json'))).toBe(false)
    registry.closeAll()
  })
})

describe('path parts from a bundle', () => {
  function bundle(name: string, edit: (project: ProjectFile) => void = () => {}, dir = join(root, 'path-parts')) {
    const path = join(dir, `${name}.wildroom`)
    for (const dir of ['Assets', 'Generations', 'Media']) mkdirSync(join(path, dir), { recursive: true })
    const now = new Date().toISOString()
    const project = { app: 'wildroom', format: 1, id: `pp${name.length}abcdefgh`, name, createdAt: now, updatedAt: now, revision: 1, summary: { durationFrames: 0 }, doc: { version: 1, spine: [], connected: [] } }
    edit(project as unknown as ProjectFile)
    writeJsonSync(join(path, 'project.json'), project)
    return path
  }

  it('refuses a project id that is not an id (it names the backups folder)', () => {
    const { env, registry } = setup('bad-project-id-home')
    const path = bundle('Evil id', (p) => (p.id = '../../escaped-backups'))
    expect(() => registry.open(path)).toThrow(expect.objectContaining({ status: 422 }))
    // Where `Backups/<id>` would have pointed.
    expect(existsSync(join(dirname(env.appDataDir), 'escaped-backups'))).toBe(false)
  })

  it('skips a job record whose id is not an id, so resuming it never writes outside the bundle', () => {
    const { registry } = setup('bad-generation-id-home')
    const path = bundle('Evil job')
    const now = new Date().toISOString()
    writeJsonSync(join(path, 'Generations', 'evil.json'), {
      id: '../../../escaped-job',
      modelId: 'kling-3.0',
      provider: 'kling',
      kind: 'video',
      status: 'submitting',
      params: {},
      outputAssetIds: [],
      createdAt: now,
      updatedAt: now,
    })
    const store = registry.open(path)
    expect(store.generations.size).toBe(0)
    expect(existsSync(join(root, 'escaped-job.json'))).toBe(false)
    registry.closeAll()
  })

  it('keeps only a safe poster file name', () => {
    const { appState, registry } = setup('bad-poster-home')
    const summary = (sha: string, ext: string) => (p: ProjectFile) => (p.summary = { durationFrames: 0, posterSha: sha, posterExt: ext })
    // Listed from the projects folder, so their cards (and posters) are drawn without opening them.
    bundle('Evil poster', summary('a'.repeat(64), '../../../../etc/passwd'), appState.projectsDir)
    bundle('Good poster', summary('b'.repeat(64), 'jpg'), appState.projectsDir)
    const entries = registry.list()
    const evil = entries.find((e) => e.name === 'Evil poster')
    expect(evil?.state).toBe('ok')
    expect(evil?.posterUrl).toBeUndefined()
    expect(entries.find((e) => e.name === 'Good poster')?.posterUrl).toBe(`/api/projects/posters/${'b'.repeat(64)}`)
  })

  it('refuses a bundle whose record folders are links to elsewhere', () => {
    const { registry } = setup('linked-folders-home')
    const path = bundle('Linked')
    const elsewhere = join(root, 'linked-target')
    mkdirSync(elsewhere, { recursive: true })
    writeFileSync(join(elsewhere, 'notes.json'), '{"id":"notes"}')
    rmSync(join(path, 'Assets'), { recursive: true })
    symlinkSync(elsewhere, join(path, 'Assets'))
    expect(() => registry.open(path)).toThrow(expect.objectContaining({ status: 422 }))
    expect(readdirSync(elsewhere)).toEqual(['notes.json'])
  })
})

describe('open projects', () => {
  it('reads a project another machine took over anew when it is opened again, instead of returning the dead store', () => {
    const { registry } = setup('reopen-suspended-home')
    const store = registry.create({ name: 'Taken back' })
    registry.attach(store.id, 'page-1')
    foreignLock(store.root)
    expect(() => store.ensureWritable()).toThrow(expect.objectContaining({ status: 409 }))
    expect(store.suspended).toBe('lock-lost')
    // Still in use there: asks before taking it back, instead of handing out a store that can't save anything.
    expect(() => registry.open(store.root)).toThrow(expect.objectContaining({ status: 409, details: expect.objectContaining({ code: 'locked' }) }))
    const reopened = registry.open(store.root, { force: true })
    expect(reopened).not.toBe(store)
    expect(reopened.suspended).toBeUndefined()
    reopened.ensureWritable()
    registry.closeAll()
  })

  it('does not stay open (or refuse rename and Trash) forever for jobs of a project it lost', async () => {
    const { registry } = setup('lost-busy-home')
    const store = registry.create({ name: 'Lost while busy' })
    const { id, root: bundle } = store
    // Stands in for unfinished jobs: they never run in a suspended project.
    registry.addBusyCheck((projectId) => projectId === id)
    expect(registry.close(id)).toBe(false)
    foreignLock(bundle)
    expect(store.putGeneration(recordToGeneration({ id: 'gen-lost', status: 'queued', params: {}, outputAssetIds: [] } as unknown as GenerationRecord, id), 'now')).toBe(false)
    await Promise.resolve()
    expect(registry.mounted(id)).toBeUndefined()

    // Lost while an editor still has it: neither renamed nor trashed under the machine that has it now.
    const other = registry.create({ name: 'Lost in an editor' })
    const otherRoot = other.root
    registry.attach(other.id, 'page-1')
    foreignLock(otherRoot)
    expect(() => other.ensureWritable()).toThrow()
    expect(() => registry.rename(other.id, 'Renamed under them')).toThrow(expect.objectContaining({ status: 409 }))
    expect(existsSync(otherRoot)).toBe(true)
    expect(existsSync(join(dirname(otherRoot), 'Renamed under them.wildroom'))).toBe(false)
    await expect(registry.trash(otherRoot)).rejects.toMatchObject({ status: 409, details: { code: 'locked' } })
    expect(existsSync(otherRoot)).toBe(true)
    registry.closeAll()
  })

  it('stops writing jobs into a project another machine took over', () => {
    const { registry, seen } = setup('takeover-home')
    const store = registry.create({ name: 'Taken over' })
    foreignLock(store.root)
    const row = recordToGeneration({ id: 'gen-after-takeover', status: 'queued', params: {}, outputAssetIds: [] } as unknown as GenerationRecord, store.id)
    expect(store.putGeneration(row, 'now')).toBe(false)
    expect(store.suspended).toBe('lock-lost')
    expect(existsSync(join(store.root, 'Generations', 'gen-after-takeover.json'))).toBe(false)
    expect(seen).toContainEqual({ type: 'project.suspended', projectId: store.id, reason: 'lock-lost' })
    registry.closeAll()
  })

  it('stays open while another editor page still has it', () => {
    const { registry } = setup('sessions-home')
    const store = registry.create({ name: 'Two tabs' })
    registry.attach(store.id, 'page-1')
    registry.attach(store.id, 'page-2')
    expect(registry.close(store.id, 'page-1')).toBe(false)
    // A one-off action (Projects page) is done with it: still open in page 2.
    expect(registry.close(store.id)).toBe(false)
    expect(registry.mounted(store.id)).toBe(store)
    expect(registry.close(store.id, 'page-2')).toBe(true)
    expect(registry.mounted(store.id)).toBeUndefined()
  })

  it('retries a coalesced write that failed instead of dropping it', () => {
    const { registry } = setup('retry-home')
    const store = registry.create({ name: 'Flaky disk' })
    const assets = join(store.root, 'Assets')
    const rec = normalizeAssetRecord({ id: 'asset-retry-000000001', kind: 'image', name: 'Clip', source: 'import', createdAt: new Date().toISOString() } as AssetRecord)
    store.putAsset(rec, 'soon')
    chmodSync(assets, 0o500)
    try {
      store.flushSync()
    } finally {
      chmodSync(assets, 0o755)
    }
    expect(existsSync(join(assets, `${rec.id}.json`))).toBe(false)
    store.flushSync()
    expect(readJsonFile<AssetRecord>(join(assets, `${rec.id}.json`))?.value).toMatchObject({ id: rec.id, name: 'Clip' })
    registry.closeAll()
  })

  it('does not fill the backups with identical copies when a project is opened again and again', () => {
    const { env, registry } = setup('backups-home')
    const store = registry.create({ name: 'Often opened' })
    const { id, root: bundle } = store
    for (let i = 0; i < 5; i++) {
      registry.close(id)
      registry.open(bundle)
    }
    expect(readdirSync(join(env.appDataDir, 'Backups', id))).toHaveLength(1)
    registry.closeAll()
  })

  it('refuses to rename a project to the name of another project folder', () => {
    const { registry } = setup('rename-home')
    registry.create({ name: 'Trailer' })
    const other = registry.create({ name: 'Teaser' })
    expect(() => registry.rename(other.id, 'Trailer')).toThrow(/already exists/)
    expect(other.name).toBe('Teaser')
    expect(other.root.endsWith('Teaser.wildroom')).toBe(true)
    registry.closeAll()
  })

  it('never trashes a project another computer has open, or a folder that is not a project', async () => {
    const { env, registry } = setup('trash-home')
    const store = registry.create({ name: 'Open elsewhere' })
    const bundle = store.root
    registry.close(store.id)
    foreignLock(bundle)
    await expect(registry.trash(bundle)).rejects.toMatchObject({ status: 409, details: { code: 'locked' } })
    expect(existsSync(bundle)).toBe(true)
    const notAProject = join(env.projectsDir, 'Some app')
    mkdirSync(notAProject, { recursive: true })
    writeFileSync(join(notAProject, 'project.json'), '{"name":"another tool"}')
    await expect(registry.trash(notAProject)).rejects.toMatchObject({ status: 400 })
    expect(existsSync(notAProject)).toBe(true)
  })
})

describe('app state', () => {
  it('starts with defaults when app.json is damaged, keeping the damaged file aside', () => {
    const env = loadEnv({ home: join(root, 'damaged-home') })
    writeFileSync(join(env.appDataDir, 'app.json'), '{"recents": [')
    const state = new AppState(env)
    expect(state.recents).toEqual([])
    expect(readdirSync(env.appDataDir).some((n) => n.startsWith('app.json.damaged-'))).toBe(true)
  })

  it('releases all locks from one exit hook', () => {
    const before = process.listenerCount('exit')
    const locks = [1, 2, 3].map((n) => {
      const dir = join(root, `lock-${n}`)
      mkdirSync(dir, { recursive: true })
      return acquireLock(dir, { file: '.lock', machineId: 'm_test' })
    })
    expect(process.listenerCount('exit')).toBeLessThanOrEqual(before + 1)
    for (const lock of locks) lock.release()
  })
})
