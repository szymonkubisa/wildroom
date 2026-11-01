import type { ExplainerRequest, ExplainerResponse } from '@shared/motion/explainer'
import type { DirectorPlanRequest, DirectorPlanResponse } from '@shared/director/plan'
import type {
  AppSettings,
  CreateGenerationRequest,
  CredentialField,
  DuplicateProjectResponse,
  EnhanceRequest,
  McpIntegrationInfo,
  ProjectDetail,
  ProjectEntry,
  ProjectSpendDTO,
  ProjectSummary,
  ProviderStatus,
  ProviderTestResult,
  SaveDocResponse,
  TempVoiceInfo,
  TempVoiceRequest,
  TrimDialogueRequest,
  TrimDialogueResponse,
} from '@shared/types/api'
import type { AssetDTO, AssetKind } from '@shared/types/assets'
import type { GenerationDTO, GenerationDetails, ProviderId } from '@shared/types/jobs'
import type { ProjectDoc, ProjectSettings } from '@shared/types/project-doc'
import type { ProjectKind } from '@shared/projects/meta'
import type { CreateKlingElementRequest, CreateKlingElementResponse } from '@shared/types/kling'
import type { TextModelInfo } from '@shared/types/llm'
import type { OpenRouterImageModel } from '@shared/models/catalog/openrouter'
import type { SceneCutsRequest, SceneCutsResponse } from '@shared/types/scenes'
import type { AssetSetRequest, AssetSetResponse } from '@shared/types/assetSet'
import type { VoiceCloneRequest, VoiceCreatedResponse, VoiceDesignRequest, VoiceDesignResponse, VoiceDesignSaveRequest } from '@shared/types/voiceLab'
import type {
  ImproveLookRequest,
  ImproveLookResponse,
  OutlineRequest,
  OutlineResponse,
  PlaceViewRequest,
  PlaceViewResponse,
  SceneShotsRequest,
  SceneShotsResponse,
  WriteScriptRequest,
  WriteScriptResponse,
} from '@shared/types/story'
import type {
  ComfyTarget,
  ComfyViewDTO,
  CreateVolumeRequest,
  GpuSessionDTO,
  RunpodAccountDTO,
  RunpodDatacenterDTO,
  RunpodVolumeDTO,
  VolumeSetupDTO,
} from '@shared/types/runpod'

export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message)
    this.name = 'ApiRequestError'
  }
}

/**
 * The local server did not answer at all: the browser's own "Failed to fetch" (nothing listens — the dev servers
 * stopped), or the dev proxy's bare 502/503/504 (the API server is down or restarting behind it).
 */
export const SERVER_UNREACHABLE = 'The studio’s local server isn’t answering — it stopped or is restarting. Try again in a moment; if it lasts, restart the app.'

/** One JSON call to the local server; failures throw ApiRequestError with the server's message and details. */
async function request<T>(method: string, path: string, body?: unknown, opts: { signal?: AbortSignal } = {}): Promise<T> {
  const headers: Record<string, string> = { 'X-Studio': '1' }
  let payload: BodyInit | undefined
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  let res: Response
  try {
    res = await fetch(`/api${path}`, { method, headers, body: payload, signal: opts.signal })
  } catch (err) {
    // An abort stays an abort (a DOMException, not a TypeError).
    if (err instanceof TypeError) throw new ApiRequestError(0, SERVER_UNREACHABLE)
    throw err
  }
  if (!res.ok) {
    let data: { error?: string; details?: unknown } | undefined
    try {
      data = (await res.json()) as typeof data
    } catch {
      // not JSON
    }
    if (!data?.error && res.status >= 502 && res.status <= 504) throw new ApiRequestError(res.status, SERVER_UNREACHABLE)
    throw new ApiRequestError(res.status, data?.error ?? `${res.status} ${res.statusText}`, data?.details)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

/** Streams one file to the server (XHR for upload progress). */
function uploadFile(
  projectId: string,
  file: File,
  onProgress?: (fraction: number) => void,
  opts: { parentIds?: string[]; label?: string } = {},
): Promise<AssetDTO> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const query = new URLSearchParams({ name: file.name })
    if (opts.parentIds?.length) query.set('parents', opts.parentIds.join(','))
    if (opts.label) query.set('label', opts.label)
    xhr.open('POST', `/api/projects/${projectId}/assets/upload?${query}`)
    xhr.setRequestHeader('X-Studio', '1')
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total)
    }
    xhr.onload = () => {
      let data: unknown
      try {
        data = JSON.parse(xhr.responseText)
      } catch {
        data = undefined
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as AssetDTO)
      else reject(new ApiRequestError(xhr.status, (data as { error?: string })?.error ?? 'Upload failed'))
    }
    xhr.onerror = () => reject(new ApiRequestError(0, SERVER_UNREACHABLE))
    xhr.send(file)
  })
}

export const api = {
  health: () =>
    request<{ ok: boolean; serverStart: string; projectsDir: string; appDataDir: string; cacheDir: string }>('GET', '/health'),
  projects: {
    /** Recent projects and the project folders found in the projects folder. */
    list: () => request<ProjectEntry[]>('GET', '/projects'),
    /** Creates a project folder in `dir` (default: the projects folder) and opens it; `kind`: what it is made as. */
    create: (name: string, settings?: Partial<ProjectSettings>, dir?: string, kind?: ProjectKind) =>
      request<ProjectDetail>('POST', '/projects', { name, settings, dir, kind }),
    /** Opens a project folder by path; `force` opens it although another machine has it open. */
    open: (path: string, force = false) => request<ProjectDetail>('POST', '/projects/open', { path, force }),
    /** `session` (an editor page) keeps the project open on the server until that page closes it. */
    get: (id: string, session?: string) =>
      request<ProjectDetail>('GET', `/projects/${id}${session ? `?session=${encodeURIComponent(session)}` : ''}`),
    rename: (id: string, name: string) => request<ProjectSummary>('PATCH', `/projects/${id}`, { name }),
    saveDoc: (id: string, doc: ProjectDoc, baseRevision: number) =>
      request<SaveDocResponse>('PUT', `/projects/${id}/doc`, { doc, baseRevision }),
    /** An editor page (`session`) or a one-off action is done with the project (it stays open while jobs run in it). */
    close: (id: string, session?: string) => request<{ closed: boolean }>('POST', `/projects/${id}/close`, { session }),
    duplicate: (id: string) => request<DuplicateProjectResponse>('POST', `/projects/${id}/duplicate`),
    trash: (path: string) => request<{ ok: true }>('POST', '/projects/trash', { path }),
    /** Removes the project from the recents list (its folder stays). */
    forget: (path: string) => request<{ ok: true }>('POST', '/projects/forget', { path }),
    reveal: (path: string) => request<{ ok: true }>('POST', '/projects/reveal', { path }),
    /** Replaces the project's tags (by folder; it isn't opened for it). Answers with them cleaned up. */
    setTags: (path: string, tags: string[]) => request<{ tags: string[] }>('POST', '/projects/tags', { path, tags }),
    /** Budget overview: what the project's generations cost, by provider and model. */
    spend: (id: string) => request<ProjectSpendDTO>('GET', `/projects/${id}/spend`),
  },
  tempVoice: {
    /** Speaks a line with a free macOS voice (animatics) and imports it as an audio asset tagged `temp-voice`. */
    create: (projectId: string, body: TempVoiceRequest) => request<AssetDTO>('POST', `/projects/${projectId}/temp-voice`, body),
    /** Installed macOS voices. */
    voices: () => request<TempVoiceInfo[]>('GET', '/temp-voice/voices'),
  },
  assets: {
    list: (projectId: string, opts: { kind?: AssetKind; q?: string } = {}) => {
      const qs = new URLSearchParams()
      if (opts.kind) qs.set('kind', opts.kind)
      if (opts.q) qs.set('q', opts.q)
      const s = qs.toString()
      return request<AssetDTO[]>('GET', `/projects/${projectId}/assets${s ? `?${s}` : ''}`)
    },
    get: (id: string) => request<AssetDTO>('GET', `/assets/${id}`),
    upload: uploadFile,
    update: (id: string, patch: { name?: string; rating?: -1 | 0 | 1; keywords?: string[]; role?: string }) =>
      request<AssetDTO>('PATCH', `/assets/${id}`, patch),
    remove: (projectId: string, id: string) => request<{ ok: true }>('DELETE', `/projects/${projectId}/assets/${id}`),
    frame: (projectId: string, id: string, seconds: number, label?: string) =>
      request<AssetDTO>('POST', `/projects/${projectId}/assets/${id}/frame`, { seconds, label }),
    reveal: (id: string, vector = false) => request<{ ok: true }>('POST', `/assets/${id}/reveal${vector ? '?vector=1' : ''}`),
    reverse: (projectId: string, id: string) => request<AssetDTO>('POST', `/projects/${projectId}/assets/${id}/reverse`),
    isolateVoice: (projectId: string, id: string) => request<AssetDTO>('POST', `/projects/${projectId}/assets/${id}/isolate-voice`),
    /** A character's voice sample for LTX: the spoken line over a quiet bed, mixed to one WAV. */
    voiceSample: (projectId: string, body: { speechAssetId: string; bedAssetId?: string; name?: string }) =>
      request<AssetDTO>('POST', `/projects/${projectId}/voice-sample`, body),
    transcribe: (id: string) => request<AssetDTO>('POST', `/assets/${id}/transcribe`),
    beats: (id: string) => request<AssetDTO>('POST', `/assets/${id}/beats`),
    describe: (id: string) => request<AssetDTO>('POST', `/assets/${id}/describe`),
    /** Where the shots change inside a video (scene detection, matched to `expected` cuts when given). */
    sceneCuts: (id: string, body: SceneCutsRequest = {}) => request<SceneCutsResponse>('POST', `/assets/${encodeURIComponent(id)}/scene-cuts`, body),
  },
  analysis: {
    frameStats: (items: FrameRef[]) => request<FrameStats[]>('POST', '/analysis/frame-stats', { items }),
    /** How alike two stills of a project are (SSIM, 1 = the same picture): a shot's start and end keyframes. Local and free. */
    frameSimilarity: (a: string, b: string) => request<{ ssim: number }>('POST', '/analysis/frame-similarity', { a, b }),
    continuity: (cuts: ContinuityCut[]) => request<{ via: string; issues: ContinuityIssue[] }>('POST', '/director/continuity', { cuts }),
    subjects: (items: FrameRef[]) => request<{ via: string; points: { x: number; y: number; label: string }[] }>('POST', '/director/subjects', { items }),
  },
  generations: {
    create: (req: CreateGenerationRequest) => request<GenerationDTO[]>('POST', '/generations', req),
    list: (projectId: string, activeOnly = false) =>
      request<GenerationDTO[]>('GET', `/projects/${projectId}/generations${activeOnly ? '?active=1' : ''}`),
    /** What was asked for, sent to the provider and answered (Assets → right-click → What was sent). */
    details: (id: string) => request<GenerationDetails>('GET', `/generations/${id}/details`),
    cancel: (id: string) => request<GenerationDTO>('POST', `/generations/${id}/cancel`),
    retry: (id: string) => request<GenerationDTO>('POST', `/generations/${id}/retry`),
    move: (id: string, to: 'top' | 'up' | 'down' | 'bottom') => request<GenerationDTO[]>('POST', `/generations/${id}/move`, { to }),
    /** Queued and running jobs of every project (the queue is shared). */
    active: () => request<GenerationDTO[]>('GET', '/generations/active'),
    /** Lately finished jobs of every project (also of projects closed since), newest first. */
    recent: () => request<GenerationDTO[]>('GET', '/generations/recent'),
    estimate: (modelId: string, params: Record<string, unknown>, variants = 1) =>
      request<{ usd: number | null; detail: string; asOf: string }>('POST', '/generations/estimate', { modelId, params, variants }),
  },
  settings: {
    get: () => request<AppSettings>('GET', '/settings'),
    update: (patch: Partial<AppSettings>) => request<AppSettings>('PATCH', '/settings', patch),
    providers: () => request<ProviderStatus[]>('GET', '/settings/providers'),
    saveProvider: (id: ProviderId, fields: Partial<Record<CredentialField, string | null>>) =>
      request<ProviderStatus>('PUT', `/settings/providers/${id}`, fields),
    testProvider: (id: ProviderId) => request<ProviderTestResult>('POST', `/settings/providers/${id}/test`),
    cache: () => request<{ bytes: number; path: string }>('GET', '/settings/cache'),
    clearCache: () => request<{ bytes: number }>('POST', '/settings/cache/clear'),
  },
  integrations: {
    /** Claude over MCP: the endpoint, the install's token and how to start the stdio bridge. */
    mcp: () => request<McpIntegrationInfo>('GET', '/integrations/mcp'),
    /** A new token: clients set up with the old one stop working. */
    renewMcpToken: () => request<McpIntegrationInfo>('POST', '/integrations/mcp/token'),
  },
  appRequests: {
    /** Takes a request Claude sent to the app's window (open a project, export): only the first page gets it. */
    claim: (id: string) => request<{ granted: boolean }>('POST', `/app-requests/${id}/claim`),
    /** Reports how a taken request went. */
    done: (id: string, outcome: { ok: true; result?: unknown } | { ok: false; error: string }) =>
      request<{ accepted: boolean }>('POST', `/app-requests/${id}/done`, outcome),
  },
  gpu: {
    /** The account's RunPod network volumes. */
    volumes: () => request<RunpodVolumeDTO[]>('GET', '/gpu/volumes'),
    /** Creates a network volume (billed monthly from creation). */
    createVolume: (body: CreateVolumeRequest) => request<RunpodVolumeDTO>('POST', '/gpu/volumes', body),
    /** Data centers with stock of LTX-capable GPUs. */
    datacenters: () => request<RunpodDatacenterDTO[]>('GET', '/gpu/datacenters'),
    account: () => request<RunpodAccountDTO>('GET', '/gpu/account'),
    session: () => request<GpuSessionDTO>('GET', '/gpu/session'),
    start: () => request<GpuSessionDTO>('POST', '/gpu/session/start'),
    stop: () => request<GpuSessionDTO>('POST', '/gpu/session/stop'),
    keep: () => request<GpuSessionDTO>('POST', '/gpu/session/keep'),
    choose: (gpuId: string) => request<GpuSessionDTO>('POST', '/gpu/session/choose', { gpuId }),
    /** Keep the renders queued and wait for the first-choice GPU. */
    keepWaiting: () => request<GpuSessionDTO>('POST', '/gpu/session/wait'),
    /** Stop waiting for the first-choice GPU and be offered the free ones again. */
    offerOthers: () => request<GpuSessionDTO>('POST', '/gpu/session/offer-others'),
    decline: () => request<GpuSessionDTO>('POST', '/gpu/session/decline'),
    setup: () => request<VolumeSetupDTO & { hfToken: { set: boolean; hint?: string } }>('GET', '/gpu/setup'),
    /** Rents a small GPU that prepares the volume (billed while it runs). */
    startSetup: (hfToken?: string) => request<VolumeSetupDTO>('POST', '/gpu/setup', { hfToken }),
    cancelSetup: () => request<VolumeSetupDTO>('POST', '/gpu/setup/cancel'),
    /** Where the pod's ComfyUI opens (a local address; the app adds the access token) and where its outputs go. */
    comfy: () => request<ComfyViewDTO>('GET', '/gpu/comfy'),
    setComfyTarget: (target: ComfyTarget) => request<ComfyViewDTO>('PUT', '/gpu/comfy/target', target),
  },
  director: {
    /** Which route and model the AI Director uses now. */
    status: () => request<{ via: 'anthropic' | 'openrouter' | 'fal' | 'demo' | 'none'; model: string; reason?: string }>('GET', '/director/status'),
    /** OpenRouter's text models (the picker's catalogue). */
    models: () => request<TextModelInfo[]>('GET', '/director/models'),
    /** "Shorten lines": the same lines in the same order, speakable within `maxSeconds`. */
    trimDialogue: (body: TrimDialogueRequest) => request<TrimDialogueResponse>('POST', '/director/trim-dialogue', body),
    /** Pass one: the script → cast, places, chapters and scenes. */
    outline: (body: OutlineRequest) => request<OutlineResponse>('POST', '/director/outline', body),
    /** Pass two: one scene's shots. */
    sceneShots: (body: SceneShotsRequest) => request<SceneShotsResponse>('POST', '/director/scene-shots', body),
    improveLook: (body: ImproveLookRequest) => request<ImproveLookResponse>('POST', '/director/improve-look', body),
    /** A place seen from another direction, written out for the look designer to draw. */
    placeView: (body: PlaceViewRequest) => request<PlaceViewResponse>('POST', '/director/place-view', body),
    writeScript: (body: WriteScriptRequest) => request<WriteScriptResponse>('POST', '/director/write-script', body),
    /** The prompt rewritten for its model; the Director reads the pictures that go with it (`references`). */
    enhance: (body: EnhanceRequest) =>
      request<{ prompt: string; via: string; model: string }>('POST', '/director/enhance', body),
    /** The canvas's asset set: the brief and deliverables → a plan of the pictures to make. */
    assetSet: (body: AssetSetRequest) => request<AssetSetResponse>('POST', '/director/asset-set', body),
    /** The Director's chat: a message and the project in brief → a reply and a plan to approve (nothing runs here). */
    plan: (body: DirectorPlanRequest) => request<DirectorPlanResponse>('POST', '/director/plan', body),
    /** An approved explainer step: its scenes written (voice-over, elements, animations). */
    explainer: (body: ExplainerRequest) => request<ExplainerResponse>('POST', '/director/explainer', body),
  },
  kling: {
    /** A character's Kling element from its pictures (Kling's element library); `replaceElementId` re-syncs one. */
    createElement: (body: CreateKlingElementRequest) => request<CreateKlingElementResponse>('POST', '/kling/elements', body),
  },
  openrouter: {
    /** OpenRouter's image models with what each supports (the "Any OpenRouter image model" picker). */
    imageModels: () => request<OpenRouterImageModel[]>('GET', '/openrouter/image-models'),
    /** One image model's price list, in words. */
    imagePricing: (model: string) =>
      request<{ model: string; lines: string[] }>('GET', `/openrouter/image-models/pricing?model=${encodeURIComponent(model)}`),
  },
  system: {
    /** Native folder picker via the local server (web version). Resolves null when canceled. */
    chooseFolder: (prompt?: string, defaultPath?: string) =>
      request<{ path: string | null }>('POST', '/system/choose-folder', { prompt, defaultPath }),
    reveal: (which: 'projects' | 'cache' | 'appData' | 'models') => request<{ ok: true }>('POST', '/system/reveal', { which }),
    revealPath: (path: string) => request<{ ok: true }>('POST', '/system/reveal-path', { path }),
    /** Which of these file names already exist in `dir` (asked before replacing them). */
    existingFiles: (dir: string, names: string[]) => request<{ existing: string[] }>('POST', '/system/existing-files', { dir, names }),
    /** Saves an exported file into `dir`; returns where it landed (a numbered name when one exists). */
    writeFile: async (dir: string, name: string, data: Blob, overwrite = false): Promise<{ path: string }> => {
      const query = new URLSearchParams({ dir, name, ...(overwrite ? { overwrite: '1' } : {}) })
      const res = await fetch(`/api/system/write-file?${query}`, {
        method: 'PUT',
        headers: { 'X-Studio': '1', 'Content-Type': 'application/octet-stream' },
        body: data,
      })
      const body = (await res.json().catch(() => ({}))) as { path?: string; error?: string }
      if (!res.ok || !body.path) throw new ApiRequestError(res.status, body.error ?? 'Could not save the file')
      return { path: body.path }
    },
  },
  voices: {
    list: (search = '', pageToken?: string, fresh = false) => {
      const qs = new URLSearchParams({ search })
      if (pageToken) qs.set('pageToken', pageToken)
      if (fresh) qs.set('fresh', '1')
      return request<{ voices: VoiceInfo[]; nextPageToken?: string }>('GET', `/voices?${qs}`)
    },
    /** Voice Lab: voices designed from a description, to listen to and keep one (aborted when the dialog moves on). */
    design: (body: VoiceDesignRequest, signal?: AbortSignal) => request<VoiceDesignResponse>('POST', '/voices/design', body, { signal }),
    /** Keeps a designed voice in the ElevenLabs account. */
    saveDesign: (body: VoiceDesignSaveRequest) => request<VoiceCreatedResponse>('POST', '/voices/design/save', body),
    /** A voice cloned from project audio (the speaker's consent given). */
    clone: (body: VoiceCloneRequest) => request<VoiceCreatedResponse>('POST', '/voices/clone', body),
  },
  exports: {
    /** Starts a browser-side export: the server keeps the encoded picture and the mix until finalize. */
    create: (body: { projectId: string; name: string; fps: number; frames: number }) => request<{ id: string }>('POST', '/exports', body),
    /** Muxes picture and mix, normalises loudness (`loudness` LUFS, null leaves levels) and adds the result to Assets. */
    finalize: (id: string, loudness: number | null) => request<AssetDTO>('POST', `/exports/${id}/finalize`, { loudness }),
    /** Drops an export and what was sent for it. */
    cancel: (id: string) => request<{ ok: true }>('DELETE', `/exports/${id}`),
  },
}

export interface FrameRef {
  assetId: string
  /** Seconds from the asset's t=0 (proxy time). */
  seconds: number
}

export interface FrameStats {
  mean: [number, number, number]
  lumaMean: number
  lumaStd: number
  saturation: number
  grid: number[]
  highlight: { x: number; y: number }
}

export interface ContinuityCut {
  cut: number
  outgoing: FrameRef
  incoming: FrameRef
  prompt?: string
  label?: string
}

export interface ContinuityIssue {
  cut: number
  severity: 'low' | 'medium' | 'high'
  category: string
  note: string
  fix: string
}

export interface VoiceInfo {
  id: string
  name: string
  category?: string
  labels?: Record<string, string>
  previewUrl?: string
  description?: string
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiRequestError) return err.message
  if (err instanceof Error) return err.message
  return String(err)
}
