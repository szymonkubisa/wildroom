import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ComfyClient, ComfyFile, ComfyHistoryEntry } from '../../src/server/providers/runpod/comfy'
import { ComfyInbox, type ComfyInboxDeps } from '../../src/server/providers/runpod/comfyInbox'
import { RunpodState } from '../../src/server/providers/runpod/state'
import { EventBus } from '../../src/server/services/events'
import type { ImportOptions } from '../../src/server/services/mediaStore'
import type { ServerEvent } from '../../src/shared/types/events'
import type { GpuSessionState } from '../../src/shared/types/runpod'

let dir: string
let state: RunpodState
let events: EventBus
let published: ServerEvent[]
let session: { podId: string | undefined; state: GpuSessionState; reconciled: boolean; costPerHr: number | undefined; up: boolean }
let queue: { running: string[]; pending: string[] }
let history: Record<string, ComfyHistoryEntry>
let imported: { path: string; content: string; opts: ImportOptions }[]
let downloads: { url: string; headers: Record<string, string> }[]
let closed: string[]
let projectMissing: boolean
/** The next this-many downloads answer 502. */
let badDownloads: number
/** Files the media store refuses. */
let unimportable: Set<string>

const client = {
  viewUrl: (f: ComfyFile) => `https://pod1-8188.proxy.runpod.net/api/view?filename=${f.filename}&type=${f.type}`,
  authHeaders: { authorization: 'Bearer tok' },
  queue: async () => queue,
  history: async (id: string) => history[id],
} as unknown as ComfyClient

function makeInbox() {
  const deps: ComfyInboxDeps = {
    session: {
      client: () => (session.up ? client : undefined),
      get podId() {
        return session.podId
      },
      get state() {
        return session.state
      },
      get reconciled() {
        return session.reconciled
      },
      get costPerHr() {
        return session.costPerHr
      },
    },
    state,
    media: {
      importFile: async (path: string, opts: ImportOptions) => {
        if (unimportable.has(opts.name)) throw new Error('Unsupported file')
        imported.push({ path, content: readFileSync(path, 'utf8'), opts })
        return { id: `asset${imported.length}` } as Awaited<ReturnType<ComfyInboxDeps['media']['importFile']>>
      },
    },
    registry: {
      mounted: () => undefined,
      require: (id: string) => {
        if (projectMissing) throw new Error('Project not found — it may have been moved or deleted')
        return { id }
      },
      holdDuring: (_id: string, work: () => Promise<unknown>) => work(),
      close: (id: string) => {
        closed.push(id)
        return true
      },
    } as unknown as ComfyInboxDeps['registry'],
    events,
    tmpDir: dir,
  }
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    downloads.push({ url, headers: init?.headers as Record<string, string> })
    if (badDownloads > 0) {
      badDownloads--
      return new Response('Bad Gateway', { status: 502 })
    }
    return new Response(`bytes of ${new URL(url).searchParams.get('filename')}`)
  }) as typeof fetch
  return new ComfyInbox(deps, { fetchImpl, now: () => Date.parse('2026-10-12T10:00:00Z') })
}

const done = (outputs: ComfyHistoryEntry['outputs'], messages: [string, Record<string, unknown>][] = []): ComfyHistoryEntry => ({
  outputs,
  status: { status_str: 'success', completed: true, messages },
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'comfy-inbox-'))
  state = new RunpodState(dir)
  events = new EventBus()
  published = []
  events.subscribe((e) => published.push(e))
  session = { podId: 'pod1', state: 'ready', reconciled: true, costPerHr: 3.6, up: true }
  queue = { running: [], pending: [] }
  history = {}
  imported = []
  downloads = []
  closed = []
  projectMissing = false
  badDownloads = 0
  unimportable = new Set()
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('ComfyUI inbox', () => {
  it('tracks prompts only when outputs have somewhere to go, and remembers them across a restart', () => {
    const inbox = makeInbox()
    inbox.track('p0') // no project chosen yet
    inbox.setTarget({ projectId: 'proj1', mode: 'off' })
    inbox.track('p1')
    expect(state.imports).toHaveLength(0)

    inbox.setTarget({ projectId: 'proj1', mode: 'append' })
    inbox.track('p2')
    inbox.track('p2')
    expect(state.imports).toEqual([{ promptId: 'p2', podId: 'pod1', projectId: 'proj1', mode: 'append', queuedAt: '2026-10-12T10:00:00.000Z' }])
    expect(inbox.pendingCount).toBe(1)

    const reloaded = new RunpodState(dir)
    expect(reloaded.imports).toHaveLength(1)
    expect(reloaded.comfyTarget).toEqual({ projectId: 'proj1', mode: 'append' })
  })

  it('saves the saved outputs (not previews) into the project once the prompt finishes', async () => {
    const inbox = makeInbox()
    inbox.setTarget({ projectId: 'proj1', mode: 'insert' })
    inbox.track('p1')
    queue = { running: ['p1'], pending: [] }
    await inbox.poll()
    expect(imported).toHaveLength(0)
    expect(state.imports).toHaveLength(1)

    queue = { running: [], pending: [] }
    history.p1 = done(
      {
        '9': { videos: [{ filename: 'clip_00001.mp4', subfolder: '', type: 'output' }], animated: [true] },
        '10': { images: [{ filename: 'preview_00001.png', subfolder: '', type: 'temp' }, { filename: 'still_00001.png', subfolder: 'stills', type: 'output' }] },
        '11': { audio: [{ filename: 'voice_00001.flac', subfolder: '', type: 'output' }], text: ['a prompt'] },
      },
      [
        ['execution_start', { timestamp: 1_000_000 }],
        ['execution_success', { timestamp: 1_060_000 }],
      ],
    )
    await inbox.poll()

    expect(imported.map((i) => [i.opts.name, i.content])).toEqual([
      ['clip_00001', 'bytes of clip_00001.mp4'],
      ['still_00001', 'bytes of still_00001.png'],
      ['voice_00001', 'bytes of voice_00001.flac'],
    ])
    expect(imported[0]!.opts).toMatchObject({
      source: 'generation',
      projectId: 'proj1',
      move: true,
      keywords: ['ComfyUI'],
      meta: { comfy: { promptId: 'p1', filename: 'clip_00001.mp4' } },
      generation: { generationId: 'comfy-p1', provider: 'runpod', costUsd: 0.06 },
    })
    expect(imported[1]!.opts.generation?.costUsd).toBeUndefined()
    expect(downloads.every((d) => d.headers.authorization === 'Bearer tok')).toBe(true)
    expect(published).toContainEqual({ type: 'comfy.imported', promptId: 'p1', projectId: 'proj1', assetIds: ['asset1', 'asset2', 'asset3'], mode: 'insert' })
    expect(state.imports).toHaveLength(0)
    // Opened only to receive the files, then let go; the downloads don't linger.
    expect(closed).toEqual(['proj1'])
    expect(imported.every((i) => !existsSync(i.path))).toBe(true)
  })

  it('reports a failed workflow and one that saved nothing', async () => {
    const inbox = makeInbox()
    inbox.setTarget({ projectId: 'proj1', mode: 'assets' })
    inbox.track('bad')
    inbox.track('empty')
    history.bad = { outputs: {}, status: { status_str: 'error', messages: [['execution_error', { exception_message: 'CUDA out of memory', node_type: 'LTXVSampler' }]] } }
    history.empty = done({ '3': { images: [{ filename: 'preview.png', subfolder: '', type: 'temp' }] } })
    await inbox.poll()
    expect(published).toEqual([
      { type: 'comfy.import.failed', promptId: 'bad', projectId: 'proj1', error: 'The workflow failed (LTXVSampler): CUDA out of memory' },
      { type: 'comfy.import.failed', promptId: 'empty', projectId: 'proj1', error: 'The workflow saved no video, image or audio (only previews)' },
    ])
    expect(state.imports).toHaveLength(0)
  })

  it('reports outputs that cannot be saved because the project is gone', async () => {
    const inbox = makeInbox()
    inbox.setTarget({ projectId: 'proj1', mode: 'assets' })
    inbox.track('p1')
    history.p1 = done({ '9': { videos: [{ filename: 'clip.mp4', subfolder: '', type: 'output' }] } })
    projectMissing = true
    await inbox.poll()
    expect(published).toEqual([
      { type: 'comfy.import.failed', promptId: 'p1', projectId: 'proj1', error: 'Could not save the outputs: Project not found — it may have been moved or deleted' },
    ])
    expect(state.imports).toHaveLength(0)
  })

  it('gives up on prompts that ComfyUI forgot or whose pod is gone', async () => {
    const inbox = makeInbox()
    inbox.setTarget({ projectId: 'proj1', mode: 'assets' })
    inbox.track('forgotten') // neither queued nor in the history
    await inbox.poll()
    expect(published.at(-1)).toMatchObject({ type: 'comfy.import.failed', promptId: 'forgotten', error: expect.stringContaining('lost this prompt') })

    inbox.track('p2')
    session = { ...session, podId: undefined, state: 'off', up: false }
    expect(inbox.pendingCount).toBe(0)
    await inbox.poll()
    expect(published.at(-1)).toMatchObject({ type: 'comfy.import.failed', promptId: 'p2', error: 'The GPU stopped before its outputs were saved' })
    expect(state.imports).toHaveLength(0)
  })

  it('keeps waiting while the app has not found its pod again after a restart', async () => {
    const inbox = makeInbox()
    inbox.setTarget({ projectId: 'proj1', mode: 'assets' })
    inbox.track('p1')
    session = { ...session, podId: undefined, state: 'off', reconciled: false, up: false }
    await inbox.poll()
    expect(state.imports).toHaveLength(1)
    expect(published).toHaveLength(0)
  })

  it('tries a failed download again on the next passes, then gives up', async () => {
    const inbox = makeInbox()
    inbox.setTarget({ projectId: 'proj1', mode: 'assets' })
    inbox.track('p1')
    history.p1 = done({ '9': { videos: [{ filename: 'clip.mp4', subfolder: '', type: 'output' }, { filename: 'clip2.mp4', subfolder: '', type: 'output' }] } })
    badDownloads = 2
    await inbox.poll()
    await inbox.poll()
    expect(published).toHaveLength(0)
    expect(imported).toHaveLength(0) // nothing half-imported meanwhile
    expect(state.imports).toHaveLength(1)
    await inbox.poll()
    expect(published).toEqual([{ type: 'comfy.imported', promptId: 'p1', projectId: 'proj1', assetIds: ['asset1', 'asset2'], mode: 'assets' }])

    inbox.track('p2')
    history.p2 = done({ '9': { videos: [{ filename: 'other.mp4', subfolder: '', type: 'output' }] } })
    badDownloads = 99
    for (let i = 0; i < 3; i++) await inbox.poll()
    expect(published.at(-1)).toEqual({ type: 'comfy.import.failed', promptId: 'p2', projectId: 'proj1', error: 'Could not download the outputs: Download failed: HTTP 502' })
    expect(state.imports).toHaveLength(0)
  })

  it('keeps the outputs that could be saved and reports the rest', async () => {
    const inbox = makeInbox()
    inbox.setTarget({ projectId: 'proj1', mode: 'append' })
    inbox.track('p1')
    history.p1 = done({ '9': { videos: [{ filename: 'a.mp4', subfolder: '', type: 'output' }, { filename: 'b.mp4', subfolder: '', type: 'output' }] } })
    unimportable.add('b')
    await inbox.poll()
    expect(published).toEqual([
      { type: 'comfy.imported', promptId: 'p1', projectId: 'proj1', assetIds: ['asset1'], mode: 'append' },
      { type: 'comfy.import.failed', promptId: 'p1', projectId: 'proj1', error: 'Could not save 1 of 2 outputs: Unsupported file' },
    ])
    expect(readdirSync(join(dir, 'comfy'))).toEqual([]) // no downloads left behind
  })

  it('waits for an import in progress when stopped', async () => {
    const inbox = makeInbox()
    inbox.setTarget({ projectId: 'proj1', mode: 'assets' })
    inbox.track('p1')
    history.p1 = done({ '9': { videos: [{ filename: 'clip.mp4', subfolder: '', type: 'output' }] } })
    const pass = inbox.poll()
    await inbox.stop()
    expect(imported).toHaveLength(1)
    await pass
  })
})
