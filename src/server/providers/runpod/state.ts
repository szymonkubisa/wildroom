import { join } from 'node:path'
import { COMFY_IMPORT_MODES, type ComfyImportMode, type ComfyTarget } from '../../../shared/types/runpod'
import { readJsonFile, writeJsonSync } from '../../storage/atomicFile'
import type { RunpodApi } from './api'

/**
 * What this machine remembers about RunPod (`<appData>/RunPod/state.json`): which volumes are prepared, the pod it
 * is running now (to find it again after a restart), pods still to delete and a log of past sessions with their cost.
 * Secrets are not here.
 */

export interface SessionLogEntry {
  podId: string
  gpuName: string
  startedAt: string
  endedAt: string
  costPerHrUsd: number
  costUsd: number
}

export interface RunpodStateFile {
  version: 1
  volumes: Record<string, { setupVersion: number; preparedAt: string }>
  /** The pod this app started and has not stopped yet. */
  pod?: { id: string; kind: 'render' | 'setup'; gpuId: string; startedAt: string; costPerHrUsd: number }
  /** Pods handed back whose delete RunPod has not confirmed yet: they may still bill (see `retirePod`). */
  pendingDeletes?: string[]
  sessions: SessionLogEntry[]
  /** Where the outputs of prompts queued from the ComfyUI page go. */
  comfyTarget?: ComfyTarget
  /** Prompts queued from the ComfyUI page whose outputs are still to be saved (kept across a restart of the app). */
  imports?: ComfyImportEntry[]
}

export interface ComfyImportEntry {
  promptId: string
  /** The pod it was queued on: once that pod is gone, so are its outputs. */
  podId: string
  projectId: string
  mode: ComfyImportMode
  queuedAt: string
}

const MAX_SESSIONS = 500

export class RunpodState {
  private readonly path: string
  private data: RunpodStateFile

  constructor(appDataDir: string) {
    this.path = join(appDataDir, 'RunPod', 'state.json')
    const loaded = readJsonFile<Partial<RunpodStateFile>>(this.path)?.value
    this.data = {
      version: 1,
      volumes: loaded?.volumes && typeof loaded.volumes === 'object' ? loaded.volumes : {},
      pod: loaded?.pod && typeof loaded.pod.id === 'string' ? loaded.pod : undefined,
      pendingDeletes: Array.isArray(loaded?.pendingDeletes) ? loaded.pendingDeletes.filter((id): id is string => typeof id === 'string') : [],
      sessions: Array.isArray(loaded?.sessions) ? loaded.sessions : [],
      comfyTarget: sanitizeTarget(loaded?.comfyTarget),
      imports: Array.isArray(loaded?.imports) ? loaded.imports.filter(isImportEntry) : [],
    }
  }

  get comfyTarget(): ComfyTarget {
    return this.data.comfyTarget ?? { mode: 'assets' }
  }

  setComfyTarget(target: ComfyTarget) {
    this.data.comfyTarget = sanitizeTarget(target)
    this.save()
  }

  get imports(): readonly ComfyImportEntry[] {
    return this.data.imports ?? []
  }

  addImport(entry: ComfyImportEntry) {
    if (this.imports.some((e) => e.promptId === entry.promptId)) return
    this.data.imports = [...this.imports, entry]
    this.save()
  }

  removeImport(promptId: string) {
    if (!this.imports.some((e) => e.promptId === promptId)) return
    this.data.imports = this.imports.filter((e) => e.promptId !== promptId)
    this.save()
  }

  get pod() {
    return this.data.pod
  }

  setPod(pod: RunpodStateFile['pod']) {
    this.data.pod = pod
    this.save()
  }

  get pendingDeletes(): readonly string[] {
    return this.data.pendingDeletes ?? []
  }

  addPendingDelete(podId: string) {
    if (this.pendingDeletes.includes(podId)) return
    this.data.pendingDeletes = [...this.pendingDeletes, podId]
    this.save()
  }

  removePendingDelete(podId: string) {
    if (!this.pendingDeletes.includes(podId)) return
    this.data.pendingDeletes = this.pendingDeletes.filter((id) => id !== podId)
    this.save()
  }

  preparedVersion(volumeId: string): number {
    return this.data.volumes[volumeId]?.setupVersion ?? 0
  }

  markPrepared(volumeId: string, setupVersion: number) {
    this.data.volumes[volumeId] = { setupVersion, preparedAt: new Date().toISOString() }
    this.save()
  }

  logSession(entry: SessionLogEntry) {
    this.data.sessions = [...this.data.sessions, entry].slice(-MAX_SESSIONS)
    this.save()
  }

  get sessions(): readonly SessionLogEntry[] {
    return this.data.sessions
  }

  private save() {
    try {
      writeJsonSync(this.path, this.data)
    } catch (err) {
      console.error('[runpod] could not save state', err)
    }
  }
}

/**
 * Terminates a pod the app is done with. RunPod bills it until the delete goes through, so it is written down first and
 * crossed off only once RunPod confirms (already gone counts): a delete that fails in an API blip is tried again by the
 * GPU session's tick and by the next app run, instead of the pod being forgotten while it runs. False if it failed.
 */
export async function retirePod(state: RunpodState, api: () => Pick<RunpodApi, 'deletePod'>, podId: string): Promise<boolean> {
  state.addPendingDelete(podId)
  try {
    await api().deletePod(podId)
    state.removePendingDelete(podId)
    return true
  } catch (err) {
    console.warn(`[runpod] could not terminate pod ${podId} — trying again`, err)
    return false
  }
}

const isMode = (v: unknown): v is ComfyImportMode => COMFY_IMPORT_MODES.includes(v as ComfyImportMode)

function sanitizeTarget(raw: unknown): ComfyTarget | undefined {
  const t = raw as Partial<ComfyTarget> | undefined
  if (!t || typeof t !== 'object' || !isMode(t.mode)) return undefined
  return { mode: t.mode, ...(typeof t.projectId === 'string' && t.projectId ? { projectId: t.projectId } : {}) }
}

function isImportEntry(raw: unknown): raw is ComfyImportEntry {
  const e = raw as Partial<ComfyImportEntry> | undefined
  return (
    typeof e?.promptId === 'string' &&
    typeof e.podId === 'string' &&
    typeof e.projectId === 'string' &&
    isMode(e.mode) &&
    typeof e.queuedAt === 'string'
  )
}
