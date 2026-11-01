import { existsSync, mkdirSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { type AppSettings, DEFAULT_MCP_SETTINGS, type McpSettings, THEME_PREFERENCES } from '../../shared/types/api'
import { DEFAULT_TEXT_CHOICE, sanitizeTextChoice } from '../../shared/types/llm'
import type { ProviderId } from '../../shared/types/jobs'
import { DEFAULT_RUNPOD_SETTINGS, sanitizeRunpodSettings } from '../../shared/types/runpod'
import type { Env } from '../env'
import { badRequest } from '../http'
import type { AppState } from '../storage/appState'
import type { EventBus } from './events'
import { setFfmpegPathOverride } from './ffmpeg'

type StoredSettings = Omit<AppSettings, 'projectsDir' | 'storage'>

const DEFAULTS: StoredSettings = {
  theme: 'dark',
  demoMode: true,
  ffmpegPath: '',
  defaultModels: {},
  favoriteModels: [],
  concurrency: {},
  queuePaused: false,
  cloudOneAtATime: true,
  textModel: DEFAULT_TEXT_CHOICE,
  runpod: DEFAULT_RUNPOD_SETTINGS,
  mcp: DEFAULT_MCP_SETTINGS,
}

/** Starred model ids: strings, once each, in order (an old or hand-edited file can hold anything). */
const sanitizeFavorites = (list: unknown): string[] =>
  Array.isArray(list) ? [...new Set(list.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 200))].slice(0, 200) : []

/** MCP settings with anything missing or out of range taken from `base`. */
function sanitizeMcp(value: unknown, base: McpSettings = DEFAULT_MCP_SETTINGS): McpSettings {
  const v = (value && typeof value === 'object' ? value : {}) as Partial<McpSettings>
  const cap = Number(v.sessionCapUsd)
  return {
    enabled: typeof v.enabled === 'boolean' ? v.enabled : base.enabled,
    sessionCapUsd: Number.isFinite(cap) && cap >= 0 && cap <= 10_000 ? Math.round(cap * 100) / 100 : base.sessionCapUsd,
  }
}

/** Non-secret app settings, kept in this machine's app state (secrets live in the Keychain). */
export class SettingsService {
  private current: StoredSettings

  constructor(
    private readonly appState: AppState,
    private readonly env: Env,
    private readonly events: EventBus,
  ) {
    this.current = { ...DEFAULTS, ...(appState.file.settings as Partial<StoredSettings>) }
    this.current.textModel = sanitizeTextChoice(this.current.textModel)
    this.current.runpod = sanitizeRunpodSettings(this.current.runpod)
    this.current.favoriteModels = sanitizeFavorites(this.current.favoriteModels)
    this.current.mcp = sanitizeMcp(this.current.mcp)
    setFfmpegPathOverride(this.current.ffmpegPath || undefined)
  }

  get(): AppSettings {
    return {
      ...this.current,
      projectsDir: this.appState.projectsDir,
      storage: { appDataDir: this.env.appDataDir, cacheDir: this.env.cacheDir, modelsDir: this.env.modelsDir },
    }
  }

  update(patch: Partial<AppSettings>): AppSettings {
    const { projectsDir, storage: _readOnly, ...rest } = patch
    if (rest.theme !== undefined && !THEME_PREFERENCES.includes(rest.theme)) throw badRequest(`Unknown theme: ${String(rest.theme)}`)
    let nextProjectsDir: string | undefined
    if (projectsDir !== undefined) {
      const dir = projectsDir.trim()
      if (!dir || !isAbsolute(dir)) throw badRequest('The projects folder must be an absolute path')
      nextProjectsDir = resolve(dir)
      try {
        if (!existsSync(nextProjectsDir)) mkdirSync(nextProjectsDir, { recursive: true })
        if (!statSync(nextProjectsDir).isDirectory()) throw new Error('not a folder')
      } catch (err) {
        throw badRequest(`Can't use ${nextProjectsDir} as the projects folder: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    this.current = {
      ...this.current,
      ...rest,
      defaultModels: { ...this.current.defaultModels, ...(rest.defaultModels ?? {}) },
      favoriteModels: rest.favoriteModels ? sanitizeFavorites(rest.favoriteModels) : this.current.favoriteModels,
      concurrency: { ...this.current.concurrency, ...(rest.concurrency ?? {}) },
      textModel: rest.textModel ? sanitizeTextChoice(rest.textModel) : this.current.textModel,
      runpod: rest.runpod ? sanitizeRunpodSettings({ ...this.current.runpod, ...rest.runpod }, this.current.runpod) : this.current.runpod,
      mcp: rest.mcp ? sanitizeMcp({ ...this.current.mcp, ...rest.mcp }, this.current.mcp) : this.current.mcp,
    }
    this.appState.update((s) => {
      s.settings = { ...this.current }
      if (nextProjectsDir) s.projectsDir = nextProjectsDir === this.env.projectsDir ? undefined : nextProjectsDir
    })
    setFfmpegPathOverride(this.current.ffmpegPath || undefined)
    this.events.publish({ type: 'settings.changed' })
    if (nextProjectsDir) this.events.publish({ type: 'projects.changed' })
    return this.get()
  }

  concurrencyFor(provider: ProviderId, fallback: number): number {
    const value = this.current.concurrency[provider]
    return typeof value === 'number' && value > 0 ? value : fallback
  }
}
