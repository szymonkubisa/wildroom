import type { ProjectKind } from '../projects/meta'
import type { ProjectDoc, ProjectSettings } from './project-doc'
import type { ProviderId } from './jobs'
import type { TextModelChoice } from './llm'
import type { RunpodSettings } from './runpod'

export interface ProjectSummary {
  id: string
  name: string
  settings: ProjectSettings
  posterAssetId?: string
  durationFrames: number
  createdAt: string
  updatedAt: string
  /** Absolute path of the project bundle (`<name>.wildroom` folder). */
  path: string
}

export type ProjectEntryState = 'ok' | 'missing' | 'locked' | 'unreadable' | 'newer-format'

/** Who has a project open, when it is not this app. */
export interface ProjectLockInfo {
  host?: string
  since?: string
  /** Another machine (its liveness can't be checked; the user may open the project anyway). */
  foreign: boolean
}

/** A project on the Projects page: a recent project, or a bundle found in the projects folder. */
export interface ProjectEntry {
  /** Absolute bundle path — the stable key (copies share an id until they are opened). */
  path: string
  id?: string
  name: string
  state: ProjectEntryState
  /** Open in this app right now. */
  open: boolean
  lockedBy?: ProjectLockInfo
  settings?: ProjectSettings
  durationFrames: number
  posterUrl?: string
  createdAt?: string
  updatedAt?: string
  lastOpenedAt?: string
  /** In this machine's recents list (otherwise only found in the projects folder). */
  recent: boolean
  /** Why the project can't be opened (unreadable, newer format). */
  message?: string
  /** Film, ad, social or edit: as made, or worked out from the document for older projects (see projectKindOf). */
  kind?: ProjectKind
  /** The project's own tags (stored in its project.json, so they travel with the folder). */
  tags?: string[]
  /** Where the project is, in a few words ("3 scenes · 14 shots"); searchable. */
  status?: string
}

/** A duplicated project, with how its ids map from the original's (documents written for the original need it). */
export interface DuplicateProjectResponse extends ProjectEntry {
  idMap: Record<string, string>
}

/** `POST /projects/tags`: replaces the project's tags (cleaned up: lower case, no "#", distinct). */
export interface SetProjectTagsRequest {
  path: string
  tags: string[]
}

export interface OpenProjectRequest {
  path: string
  /** Open even though another machine (or app instance) has it open. */
  force?: boolean
}

/** `details` of project API errors. */
export type ProjectErrorDetails =
  | { code: 'locked'; lockedBy: ProjectLockInfo }
  | { code: 'missing'; path?: string }
  | { code: 'not-a-project' }
  | { code: 'newer-format' }
  | { code: 'unreadable' }
  | { code: 'lock-lost' }
  | { code: 'busy' }
  /** Rename: another project folder already has that name. */
  | { code: 'exists' }

export interface ProjectDetail extends ProjectSummary {
  doc: ProjectDoc
  revision: number
}

export interface SaveDocRequest {
  doc: ProjectDoc
  baseRevision: number
}

export interface SaveDocResponse {
  revision: number
  updatedAt: string
}

/** Keychain fields; uploadTarget/uploadUrl (OpenRouter's camera-guide host) are not secret but live with the key. */
export type CredentialField = 'apiKey' | 'accessKey' | 'secretKey' | 'uploadTarget' | 'uploadUrl'

export interface ProviderStatus {
  id: ProviderId
  label: string
  configured: boolean
  /** Which credential fields are stored (values are never sent to the browser). */
  fields: Partial<Record<CredentialField, { set: boolean; hint?: string }>>
  enabled: boolean
  /** Why a provider without credentials (a local model) is or is not ready. */
  detail?: string
  /** Per-model readiness when the provider's models are installed separately (keyed by model id). */
  models?: Record<string, ModelReadiness>
}

export interface ModelReadiness {
  ready: boolean
  detail: string
}

export interface ProviderTestResult {
  ok: boolean
  message: string
  credits?: { label: string; remaining?: number; limit?: number; unit: string; resetsAt?: string }
}

/** Where the app keeps things on this machine (read-only in Settings). */
export interface StorageInfo {
  /** Settings, recent projects, project backups. */
  appDataDir: string
  /** Regenerable proxies, posters, waveforms and scratch files. */
  cacheDir: string
  modelsDir: string
}

/** UI colour scheme; `system` follows macOS. */
export type ThemePreference = 'dark' | 'light' | 'system'
export const THEME_PREFERENCES: readonly ThemePreference[] = ['dark', 'light', 'system']

export interface AppSettings {
  theme: ThemePreference
  demoMode: boolean
  /** Default folder for new projects. */
  projectsDir: string
  storage: StorageInfo
  ffmpegPath: string
  defaultModels: Partial<Record<string, string>> // GenKind -> modelId
  /** Starred models, in the order starred: on top of the Composer's model menu; the first of a kind is its default. */
  favoriteModels: string[]
  concurrency: Partial<Record<ProviderId, number>>
  /** Nothing new starts while paused; running jobs finish. */
  queuePaused: boolean
  /** Cloud jobs run one at a time (local renders always do); off runs them in parallel per provider. */
  cloudOneAtATime: boolean
  /** Text model of the AI Director (scripts, briefs, prompt help, frame analysis) and which key runs it. */
  textModel: TextModelChoice
  /** Rented GPU for LTX-2.5 (the API key itself is in the Keychain). */
  runpod: RunpodSettings
  /** Claude (Claude Code, Claude Desktop) driving the app over MCP: Settings → Integrations. */
  mcp: McpSettings
}

export interface McpSettings {
  /** `/mcp` answers (with the install's token); off, every MCP request is refused. */
  enabled: boolean
  /** The most one MCP session may spend on paid renders (estimated USD); each paid render still needs its price confirmed. */
  sessionCapUsd: number
}

export const DEFAULT_MCP_SETTINGS: McpSettings = { enabled: true, sessionCapUsd: 5 }

/** Settings → Integrations: how to connect Claude to this server. */
export interface McpIntegrationInfo {
  enabled: boolean
  /** The Streamable HTTP endpoint, e.g. http://127.0.0.1:7777/mcp. */
  url: string
  token: string
  /** The stdio bridge for clients that only start commands (Claude Desktop): command, args and env to run it. */
  bridge: { command: string; args: string[]; env?: Record<string, string> }
  /** Where the server writes its port and the token (the bridge reads them). */
  appDataDir: string
}

export interface CreateGenerationRequest {
  projectId: string
  modelId: string
  params: Record<string, unknown>
  variants?: number
  /**
   * What to call the render and its media ("Valentina emerges from the party…"); without it, the start of the prompt.
   * The storyboard names a take after its shot's description.
   */
  label?: string
}

/** `POST /projects/:projectId/temp-voice`: a free macOS voice for animatics, replaced by real TTS later. */
export interface TempVoiceRequest {
  /** The line; ElevenLabs audio tags such as "[whispering]" are dropped before speaking. */
  text: string
  /** A `say` voice name (GET /temp-voice/voices). Default: a Polish voice for Polish text, else the system voice. */
  voice?: string
  /** Words per minute (say's `-r`, clamped to 90–400). */
  rate?: number
  /** Asset name (default "Temp voice · <first words>"). */
  name?: string
}

/** Temp voices are imported with this keyword (and `meta.tempVoice`), so the UI can flag and replace them. */
export const TEMP_VOICE_KEYWORD = 'temp-voice'

/** An installed macOS voice (`say -v '?'`). */
export interface TempVoiceInfo {
  name: string
  /** e.g. pl_PL, en_GB. */
  locale: string
}

/** A picture that goes to the generator with the prompt, shown to the Director when it rewrites the prompt. */
export interface EnhanceReference {
  assetId: string
  /** start / end frame, a reference to follow, or the image being edited. */
  role: 'start' | 'end' | 'reference' | 'input'
  /** How the prompt names it for this model ("image 1", "@Image1", "the start frame"). */
  token: string
}

/** The kinds whose prompts the Director rewrites (speech isn't one: its prompt is the words to say). */
export const ENHANCE_KINDS = ['video', 'image', 'music', 'sfx', 'foley'] as const
export type EnhanceKind = (typeof ENHANCE_KINDS)[number]

/** `POST /director/enhance`: the Composer's prompt rewritten for its model, reading the pictures that go with it. */
export interface EnhanceRequest {
  prompt: string
  /** The generator's kind: a picture or clip, or a sound (music, sound effect, foley for a video). */
  kind: EnhanceKind
  style?: string
  /** The generator's name ("Seedream 5 Pro"). */
  model?: string
  references?: EnhanceReference[]
}

/** `POST /director/trim-dialogue`: shorten lines so they can be spoken within `maxSeconds` (~2.5 words/s). */
export interface TrimDialogueRequest {
  lines: { speaker: string; text: string }[]
  maxSeconds: number
  /** Language of the lines (default: keep each line's own language). */
  language?: string
}

export interface TrimDialogueResponse {
  /** One shortened line per input line, same order; each keeps its leading [audio tag]. */
  lines: string[]
  /** anthropic | openrouter | fal | demo */
  via: string
  model?: string
}

/** `GET /projects/:id/spend`: what the project's generations cost (USD as recorded by the providers or estimated). */
export interface ProjectSpendDTO {
  totalUsd: number
  byProvider: Record<string, number>
  /** Keyed by model id. */
  byModel: Record<string, { usd: number; count: number }>
  /** Generations counted: every succeeded one, plus failed ones that report a charge. */
  count: number
  /** Creation time of the oldest counted generation. */
  since?: string
  /**
   * RunPod GPU time billed on this machine, all projects together (pod sessions aren't tied to a project; includes
   * boot and idle time and the pod running now). Each project's share of render time is in `byProvider.runpod`.
   */
  gpuSessionsUsd?: number
}
