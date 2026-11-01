import { mkdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { nanoid } from 'nanoid'
import type { ComfyTarget, GpuSessionState } from '../../../shared/types/runpod'
import type { EventBus } from '../../services/events'
import type { MediaStore } from '../../services/mediaStore'
import type { ProjectRegistry } from '../../storage/registry'
import { saveBody } from '../http'
import type { ComfyClient, ComfyFile } from './comfy'
import { historyError, historyFiles, historyRenderMs, renderCost } from './history'
import type { ComfyImportEntry, RunpodState } from './state'

/** Files worth saving from a prompt (what ComfyUI's Save Video/Image/Audio nodes write). */
const MEDIA_EXT = /\.(mp4|webm|mov|mkv|gif|png|jpe?g|webp|wav|mp3|flac|ogg|m4a)$/i
const POLL_MS = 5000
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000
/** Passes whose download failed before a prompt's outputs are given up. */
const MAX_DOWNLOAD_TRIES = 3

export interface ComfyInboxDeps {
  session: {
    client(): ComfyClient | undefined
    readonly podId: string | undefined
    readonly state: GpuSessionState
    readonly reconciled: boolean
    readonly costPerHr: number | undefined
  }
  state: RunpodState
  media: Pick<MediaStore, 'importFile'>
  registry: Pick<ProjectRegistry, 'require' | 'mounted' | 'holdDuring' | 'close'>
  events: EventBus
  tmpDir: string
}

export interface ComfyInboxOptions {
  pollMs?: number
  fetchImpl?: typeof fetch
  now?: () => number
}

/**
 * Prompts queued by hand from the ComfyUI page (the app's proxy reports each one): when they finish, their saved
 * outputs are copied into the chosen project's Assets. The editor then appends or inserts them if asked to.
 */
export class ComfyInbox {
  private timer: NodeJS.Timeout | undefined
  /** The pass in progress (shutdown waits for it). */
  private running: Promise<void> | undefined
  /** Failed download passes by prompt. */
  private readonly downloadFailures = new Map<string, number>()
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number

  constructor(
    private readonly deps: ComfyInboxDeps,
    private readonly opts: ComfyInboxOptions = {},
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.now = opts.now ?? Date.now
  }

  get target(): ComfyTarget {
    return this.deps.state.comfyTarget
  }

  setTarget(target: ComfyTarget) {
    this.deps.state.setComfyTarget(target)
  }

  /** Prompts on the running pod whose outputs are still to be saved (they keep it from stopping). */
  get pendingCount(): number {
    const podId = this.deps.session.podId
    return podId ? this.deps.state.imports.filter((e) => e.podId === podId).length : 0
  }

  /** A prompt was queued from the ComfyUI page. */
  track(promptId: string) {
    const { projectId, mode } = this.target
    const podId = this.deps.session.podId
    if (mode === 'off' || !projectId || !podId) return
    this.deps.state.addImport({ promptId, podId, projectId, mode, queuedAt: new Date(this.now()).toISOString() })
  }

  start() {
    this.timer = setInterval(() => void this.poll(), this.opts.pollMs ?? POLL_MS)
    this.timer.unref?.()
  }

  /** Stops polling; resolves once a pass in progress (a download, an import) is done. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await this.running
  }

  /** One pass: saves the outputs of every prompt that finished, drops the ones that can't finish any more. */
  async poll(): Promise<void> {
    if (this.running || !this.deps.state.imports.length) return
    this.running = this.pass().finally(() => (this.running = undefined))
    await this.running
  }

  private async pass() {
    const { session } = this.deps
    const entries = [...this.deps.state.imports]
    // Its pod is gone (stopped, or another one runs now): the outputs went with it.
    const lost = entries.filter((e) => (session.podId ? session.podId !== e.podId : session.reconciled && (session.state === 'off' || session.state === 'error')))
    for (const e of lost) this.fail(e, 'The GPU stopped before its outputs were saved')
    const client = session.client()
    if (!client) return
    const mine = entries.filter((e) => e.podId === session.podId)
    if (!mine.length) return
    // The queue first, then the history: a prompt in neither has really vanished (ComfyUI restarted).
    let queued: Set<string>
    try {
      const q = await client.queue()
      queued = new Set([...q.running, ...q.pending])
    } catch {
      return // the next pass tries again
    }
    for (const e of mine) {
      let entry
      try {
        entry = await client.history(e.promptId)
      } catch {
        continue
      }
      if (!entry) {
        if (!queued.has(e.promptId)) this.fail(e, 'ComfyUI lost this prompt (it restarted)')
        continue
      }
      const error = historyError(entry)
      if (error) {
        this.fail(e, `The workflow failed${error.nodeType ? ` (${error.nodeType})` : ''}: ${error.message}`)
        continue
      }
      const files = historyFiles(entry).filter((f) => f.type === 'output' && MEDIA_EXT.test(f.filename))
      if (!files.length) {
        this.fail(e, 'The workflow saved no video, image or audio (only previews)')
        continue
      }
      // Everything is downloaded before anything is imported: a failed download leaves the project untouched and
      // is tried again on the next passes (usually a passing hiccup of RunPod's proxy).
      let downloaded: Downloaded[]
      try {
        downloaded = await this.downloadAll(client, files)
      } catch (err) {
        const tries = (this.downloadFailures.get(e.promptId) ?? 0) + 1
        this.downloadFailures.set(e.promptId, tries)
        if (tries >= MAX_DOWNLOAD_TRIES) this.fail(e, `Could not download the outputs: ${message(err)}`)
        continue
      }
      this.downloadFailures.delete(e.promptId)
      const saved = await this.save(e, downloaded, renderCost(historyRenderMs(entry), session.costPerHr))
      const { assetIds } = saved
      this.deps.state.removeImport(e.promptId)
      if (assetIds.length) this.deps.events.publish({ type: 'comfy.imported', promptId: e.promptId, projectId: e.projectId, assetIds, mode: e.mode })
      if (saved.error) {
        const what = assetIds.length ? `${files.length - assetIds.length} of ${files.length} outputs` : 'the outputs'
        this.deps.events.publish({ type: 'comfy.import.failed', promptId: e.promptId, projectId: e.projectId, error: `Could not save ${what}: ${saved.error}` })
      }
    }
  }

  /** Every file into the temp folder; on a failure the ones already there are removed again. */
  private async downloadAll(client: ComfyClient, files: ComfyFile[]): Promise<Downloaded[]> {
    const dir = join(this.deps.tmpDir, 'comfy')
    mkdirSync(dir, { recursive: true })
    const done: Downloaded[] = []
    try {
      for (const file of files) {
        const path = join(dir, `${nanoid(8)}${extname(file.filename).toLowerCase()}`)
        done.push({ file, path })
        const res = await this.fetchImpl(client.viewUrl(file), { headers: client.authHeaders, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
        await saveBody(res, path)
      }
      return done
    } catch (err) {
      await removeAll(done)
      throw err
    }
  }

  /** Imports what was downloaded; a file that can't be imported doesn't stop the others. */
  private async save(e: ComfyImportEntry, files: Downloaded[], costUsd: number | undefined): Promise<{ assetIds: string[]; error?: string }> {
    const { registry, media } = this.deps
    const assetIds: string[] = []
    let error: string | undefined
    try {
      const wasMounted = Boolean(registry.mounted(e.projectId))
      const project = registry.require(e.projectId)
      try {
        await registry.holdDuring(project.id, async () => {
          for (const [i, { file, path }] of files.entries()) {
            try {
              const asset = await media.importFile(path, {
                name: file.filename.replace(/\.[^.]+$/, ''),
                source: 'generation',
                projectId: project.id,
                generation: {
                  generationId: `comfy-${e.promptId}`,
                  modelId: 'comfyui-workflow',
                  modelLabel: 'ComfyUI workflow',
                  provider: 'runpod',
                  params: {},
                  // The GPU time is the prompt's, not each file's.
                  costUsd: i === 0 ? costUsd : undefined,
                },
                keywords: ['ComfyUI'],
                meta: { comfy: { promptId: e.promptId, filename: file.filename } },
                move: true,
              })
              assetIds.push(asset.id)
            } catch (err) {
              error ??= message(err)
            }
          }
        })
      } finally {
        // Opened only to receive the files: let it go again (it stays open if an editor has it).
        if (!wasMounted) registry.close(project.id)
      }
    } catch (err) {
      error ??= message(err)
    } finally {
      // Moved into the project when imported; whatever is left goes.
      await removeAll(files)
    }
    return { assetIds, error }
  }

  private fail(e: ComfyImportEntry, error: string) {
    this.downloadFailures.delete(e.promptId)
    this.deps.state.removeImport(e.promptId)
    this.deps.events.publish({ type: 'comfy.import.failed', promptId: e.promptId, projectId: e.projectId, error })
  }
}

interface Downloaded {
  file: ComfyFile
  path: string
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

async function removeAll(files: Downloaded[]) {
  await Promise.all(files.map((f) => rm(f.path, { force: true }).catch(() => {})))
}
