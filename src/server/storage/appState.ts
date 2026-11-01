import { renameSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { nanoid } from 'nanoid'
import type { Env } from '../env'
import { readJsonFile, writeJsonSync } from './atomicFile'

/** A project this machine has opened (newest first). Paths are absolute; the id is the bundle's project id. */
export interface RecentProject {
  path: string
  id: string
  name: string
  lastOpenedAt: string
  /** This machine left unfinished generation jobs in it: mount it again on start so they finish. */
  hasActiveJobs?: boolean
}

export interface AppStateFile {
  version: 1
  /** Non-secret app settings (see SettingsService). */
  settings: Record<string, unknown>
  /** Default folder for new projects (env.projectsDir when unset). */
  projectsDir?: string
  /** Model weights folder when it could not be moved to the default location. */
  modelsDir?: string
  recents: RecentProject[]
}

const MAX_RECENTS = 50

/**
 * Machine-local app state in `<appData>/app.json`: settings, the recent-projects list and the default projects
 * folder. `<appData>/machine.json` holds a stable id for this machine, used by project locks and to tell which
 * machine last worked on a bundle (host names change with the network).
 */
export class AppState {
  readonly machineId: string
  readonly host = hostname()
  private state: AppStateFile
  private readonly path: string

  constructor(private readonly env: Env) {
    this.path = join(env.appDataDir, 'app.json')
    this.machineId = loadMachineId(env.appDataDir)
    const loaded = loadAppState(this.path)
    this.state = {
      version: 1,
      settings: loaded.settings && typeof loaded.settings === 'object' ? loaded.settings : {},
      projectsDir: typeof loaded.projectsDir === 'string' ? loaded.projectsDir : undefined,
      modelsDir: typeof loaded.modelsDir === 'string' ? loaded.modelsDir : undefined,
      recents: Array.isArray(loaded.recents) ? loaded.recents.filter((r) => r && typeof r.path === 'string' && typeof r.id === 'string') : [],
    }
  }

  get file(): Readonly<AppStateFile> {
    return this.state
  }

  get projectsDir(): string {
    return this.state.projectsDir ?? this.env.projectsDir
  }

  get recents(): readonly RecentProject[] {
    return this.state.recents
  }

  update(mutate: (state: AppStateFile) => void) {
    mutate(this.state)
    this.state.recents = this.state.recents.slice(0, MAX_RECENTS)
    writeJsonSync(this.path, this.state)
  }

  recentById(id: string): RecentProject | undefined {
    return this.state.recents.find((r) => r.id === id)
  }

  recentByPath(path: string): RecentProject | undefined {
    return this.state.recents.find((r) => r.path === path)
  }

  /** Moves (or adds) the project to the top of the recents list. */
  touchRecent(entry: Omit<RecentProject, 'lastOpenedAt'> & { lastOpenedAt?: string }) {
    this.update((s) => {
      const previous = s.recents.find((r) => r.path === entry.path || r.id === entry.id)
      s.recents = s.recents.filter((r) => r !== previous && r.path !== entry.path)
      s.recents.unshift({
        path: entry.path,
        id: entry.id,
        name: entry.name,
        lastOpenedAt: entry.lastOpenedAt ?? new Date().toISOString(),
        hasActiveJobs: entry.hasActiveJobs ?? previous?.hasActiveJobs,
      })
    })
  }

  /** Updates fields of a recent entry in place (no reordering). */
  patchRecent(id: string, patch: Partial<RecentProject>) {
    const entry = this.recentById(id)
    if (!entry) return
    const changed = Object.entries(patch).some(([k, v]) => entry[k as keyof RecentProject] !== v)
    if (changed) this.update(() => Object.assign(entry, patch))
  }

  forgetRecent(path: string) {
    if (!this.recentByPath(path)) return
    this.update((s) => {
      s.recents = s.recents.filter((r) => r.path !== path)
    })
  }
}

/** app.json, or empty state when it is missing or damaged (a damaged file is kept aside, never overwritten). */
function loadAppState(path: string): Partial<AppStateFile> {
  try {
    const value = readJsonFile<Partial<AppStateFile> | null>(path)?.value
    return value && typeof value === 'object' ? value : {}
  } catch (err) {
    const aside = `${path}.damaged-${new Date().toISOString().replace(/[:.]/g, '-')}`
    console.warn(`[app] ${path} is damaged (${err instanceof Error ? err.message : String(err)}) — starting with defaults, kept it as ${aside}`)
    try {
      renameSync(path, aside)
    } catch {
      // leave it; the next save replaces it
    }
    return {}
  }
}

function loadMachineId(appDataDir: string): string {
  const path = join(appDataDir, 'machine.json')
  try {
    const existing = readJsonFile<{ machineId?: unknown }>(path)?.value.machineId
    if (typeof existing === 'string' && existing) return existing
  } catch {
    // unreadable: replace it
  }
  const machineId = `m_${nanoid(16)}`
  writeJsonSync(path, { machineId, host: hostname(), createdAt: new Date().toISOString() })
  return machineId
}
