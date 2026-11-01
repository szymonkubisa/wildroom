import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { motionImportSchema, type MotionImportResult } from '../../shared/motion/importSchema'
import { parseParams } from '../../shared/models/params'
import { allModels, getModel } from '../../shared/models/registry'
import type { ModelSpec, ParamValues } from '../../shared/models/types'
import { sanitizeStory } from '../../shared/story/structure'
import { layoutTimeline } from '../../shared/timeline/layout'
import { flicksToSeconds } from '../../shared/time/flicks'
import type { AssetDTO } from '../../shared/types/assets'
import type { ProjectDetail, ProjectEntry, ProviderStatus, SaveDocResponse } from '../../shared/types/api'
import { TERMINAL_JOB_STATUSES, type GenerationDTO } from '../../shared/types/jobs'
import type { Clip, ProjectDoc } from '../../shared/types/project-doc'
import type { StoryDoc } from '../../shared/types/story'
import type { AppDeps } from '../app'
import { directorCredentials } from '../routes/director'
import { frameJpeg } from '../services/analysis'
import { NotClaimedError } from '../services/appRequests'
import { allowedFile, importRoots } from '../services/motionImport'
import { timelineOpSchema } from '../services/timelineOps'
import { checkSpend, isFreeModel } from './costGuard'

/** Calls the app's own HTTP API in-process (same validation, events and locking as the app's pages). */
export type StudioApi = <T>(method: string, path: string, body?: unknown) => Promise<T>

/** One MCP session: what it spent, and the projects it opened (closed again when the session ends). */
export interface McpSessionState {
  spentUsd: number
  projects: Set<string>
}

export interface ToolContext {
  deps: AppDeps
  api: StudioApi
  session: McpSessionState
}

const json = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] })
const text = (value: string): CallToolResult => ({ content: [{ type: 'text', text: value }] })
const round = (n: number, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits

const projectRef = z.string().min(1).describe('The project: its id (from list_projects / create_project), its exact name, or the path of its .wildroom folder')

export const SERVER_INSTRUCTIONS = `Wildroom is the user's Mac app for AI video, images, sound and motion graphics. These tools drive the running app: whatever you make shows up in it live.

How to build:
- list_projects / create_project / open_project, then get_project to see the timeline, boards, story and assets.
- Explainers and motion graphics: write one motion-import JSON (get_motion_import_guide has the format) — boards with frames, text, shapes and pictures; motion clips with keyframed tracks; voice-over and music; markers; brand — and send it with motion_import. Media can be files on this Mac (absolute paths) or assets already in the project (their ids).
- Pictures, video, voice, music: list_models, then generate; get_job (wait_seconds) returns the result and shows you pictures. temp_voice makes a free macOS voice-over for timing.
- Timeline: add_to_timeline places assets; edit_timeline removes, moves, trims, cuts and changes clips by id.
- Story films: director (plan, outline, write_script, scene_shots…) and set_story.
- open_in_app shows the project in the app's editor; export_video renders the timeline to an MP4 with the app's own renderer.

Money: generate never spends without the user's agreement. A paid model answers first with its price; ask the user, then call again with confirm_usd. Demo models (provider "mock", in demo mode) and local models are free. Each MCP session has a spend cap set in the app (Settings → Integrations). The director costs a few cents of text-model tokens when an API key is set: it needs confirm: true then.

Frames are at the project's fps (get_project shows it); seconds are given where they say so.`

// ------------------------------------------------------------------------------------------------ summaries

function clipFacts(clip: Clip) {
  const assetId = clip.kind === 'media' ? (clip.takes[clip.active] ?? clip.takes[0])?.assetId : undefined
  return {
    kind: clip.kind,
    name: clip.name,
    ...(assetId ? { assetId } : {}),
    ...(clip.kind === 'media' && clip.speed !== 1 ? { speed: clip.speed } : {}),
    ...(clip.kind === 'title' ? { text: clip.text } : {}),
    ...(clip.kind === 'motion' ? { boardId: clip.boardId, frameId: clip.frameId } : {}),
    ...(clip.enabled === false ? { enabled: false } : {}),
  }
}

/** The project as Claude needs it: settings, the timeline by clip, boards with their frames, the story in brief. */
export function summarizeDoc(doc: ProjectDoc) {
  const layout = layoutTimeline(doc)
  const fps = doc.settings.fps
  const story = doc.story
  return {
    settings: doc.settings,
    durationFrames: layout.duration,
    durationSeconds: round(layout.duration / fps),
    timeline: {
      storyline: layout.spine.map((s) => ({ id: s.id, start: s.start, duration: s.end - s.start, ...clipFacts(s.item) })),
      connected: layout.connected.map((c) => ({ id: c.id, start: c.start, duration: c.end - c.start, lane: c.lane, ...clipFacts(c.item.clip) })),
      markers: layout.markers.map((m) => ({ id: m.id, frame: m.frame, name: m.name, kind: m.kind })),
    },
    boards: (doc.canvas?.boards ?? []).map((b) => ({
      id: b.id,
      name: b.name,
      elements: b.items.length,
      frames: b.items.filter((i) => i.kind === 'frame').map((f) => ({ id: f.id, name: f.name, x: f.x, y: f.y, w: f.w, h: f.h })),
    })),
    ...(story
      ? {
          story: {
            title: story.title,
            logline: story.logline,
            characters: story.characters.map((c) => c.name),
            places: (story.places ?? []).map((p) => p.name),
            scenes: (story.scenes ?? []).length,
            shots: story.shots.length,
          },
        }
      : {}),
    ...(doc.brand ? { brand: { name: doc.brand.name, colors: doc.brand.colors?.length ?? 0 } } : {}),
  }
}

function assetFacts(a: AssetDTO) {
  return {
    id: a.id,
    kind: a.kind,
    name: a.name,
    status: a.status,
    source: a.source,
    ...(a.durationFlicks ? { durationSeconds: round(flicksToSeconds(a.durationFlicks)) } : {}),
    ...(a.width ? { width: a.width, height: a.height } : {}),
    ...(a.role ? { role: a.role } : {}),
    ...(a.alignment?.words?.length ? { words: a.alignment.words.length } : {}),
    ...(a.generation ? { model: a.generation.modelId } : {}),
    ...(a.description ? { description: a.description } : {}),
  }
}

function paramFacts(model: ModelSpec) {
  return model.params
    .filter((p) => !p.ui.hidden)
    .map((p) => ({
      key: p.key,
      label: p.ui.label,
      control: p.ui.control,
      ...(p.default !== undefined ? { default: p.default } : {}),
      ...(p.ui.options ? { options: p.ui.options.map((o) => o.value) } : {}),
      ...(p.ui.min !== undefined ? { min: p.ui.min } : {}),
      ...(p.ui.max !== undefined ? { max: p.ui.max } : {}),
      ...(p.ui.unit ? { unit: p.ui.unit } : {}),
      ...(p.ui.help ? { help: p.ui.help } : {}),
      ...(p.ui.advanced ? { advanced: true } : {}),
    }))
}

function defaultsOf(model: ModelSpec): ParamValues {
  return Object.fromEntries(model.params.filter((p) => p.default !== undefined).map((p) => [p.key, p.default]))
}

function priceHint(model: ModelSpec): number | null {
  try {
    return model.estimateCost(defaultsOf(model)).usd
  } catch {
    return null
  }
}

function jobFacts(j: GenerationDTO) {
  return {
    id: j.id,
    status: j.status,
    ...(j.statusDetail ? { detail: j.statusDetail } : {}),
    ...(j.progress != null ? { progress: round(j.progress) } : {}),
    model: j.modelId,
    label: j.label,
    outputAssetIds: j.outputAssetIds,
    ...(j.costEstimateUsd != null ? { estimateUsd: j.costEstimateUsd } : {}),
    ...(j.costUsd != null ? { costUsd: j.costUsd } : {}),
    ...(j.error ? { error: j.error } : {}),
  }
}

/** Where the docs are: next to the bundled server in the desktop app, the repo's docs/ in development. */
function readDoc(name: string): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const dir of [process.env.STUDIO_DOCS_DIR, join(here, 'docs'), resolve('docs')]) {
    if (!dir) continue
    const path = join(dir, name)
    if (existsSync(path)) return readFileSync(path, 'utf8')
  }
  return undefined
}

// ------------------------------------------------------------------------------------------------ tools

export function registerStudioTools(server: McpServer, ctx: ToolContext) {
  const { deps, api, session } = ctx

  /** An id, an exact name or a bundle path → the project's id (opening it when needed). */
  async function projectId(ref: string): Promise<string> {
    let id: string
    if (isAbsolute(ref) || ref.endsWith('.wildroom')) {
      id = (await api<ProjectDetail>('POST', '/api/projects/open', { path: resolve(ref) })).id
    } else {
      const entries = await api<ProjectEntry[]>('GET', '/api/projects')
      const byId = entries.find((e) => e.id === ref)
      const byName = entries.filter((e) => e.name === ref)
      if (byId?.id) id = byId.id
      else if (byName.length === 1 && byName[0]!.id) id = byName[0]!.id
      else if (byName.length > 1) throw new Error(`More than one project is called "${ref}": use its id (list_projects)`)
      else id = ref // a mounted project the list doesn't show yet; the API says if it isn't one
    }
    session.projects.add(id)
    return id
  }

  const loadProject = (id: string) => api<ProjectDetail>('GET', `/api/projects/${encodeURIComponent(id)}`)

  /** A JPEG of an image or of a video's frame, for Claude to look at. */
  async function picture(assetId: string, atSeconds = 0, width = 768): Promise<CallToolResult['content'][number] | undefined> {
    const row = deps.media.get(assetId)
    if (!row || row.deletedAt || (row.kind !== 'image' && row.kind !== 'video')) return undefined
    const jpeg = await frameJpeg(deps.media.originalPath(row), atSeconds, deps.env.tmpDir, width)
    return { type: 'image', data: jpeg.toString('base64'), mimeType: 'image/jpeg' }
  }

  server.registerTool(
    'studio_status',
    {
      title: 'App status',
      description: 'The app, its demo mode, which providers have keys (never the keys), the Director’s text model, and what this MCP session has spent against its cap.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      const settings = deps.settings.get()
      const providers = await api<ProviderStatus[]>('GET', '/api/settings/providers')
      const director = await api<{ via: string; model: string; reason?: string }>('GET', '/api/director/status')
      return json({
        app: 'Wildroom',
        server: `http://${deps.env.host}:${deps.env.port}`,
        demoMode: settings.demoMode,
        queuePaused: settings.queuePaused,
        projectsDir: settings.projectsDir,
        providers: providers.map((p) => ({ id: p.id, label: p.label, configured: p.configured, ...(p.detail ? { detail: p.detail } : {}) })),
        director,
        session: { spentUsd: round(session.spentUsd, 3), capUsd: settings.mcp.sessionCapUsd },
      })
    },
  )

  server.registerTool(
    'list_projects',
    { title: 'List projects', description: 'Recent projects and those in the projects folder.', annotations: { readOnlyHint: true } },
    async () => {
      const entries = await api<ProjectEntry[]>('GET', '/api/projects')
      return json(
        entries.map((e) => ({
          id: e.id,
          name: e.name,
          path: e.path,
          kind: e.kind,
          state: e.state,
          open: e.open,
          ...(e.settings ? { durationSeconds: round(e.durationFrames / e.settings.fps), size: `${e.settings.width}×${e.settings.height}`, fps: e.settings.fps } : {}),
          ...(e.status ? { status: e.status } : {}),
          updatedAt: e.updatedAt,
        })),
      )
    },
  )

  server.registerTool(
    'create_project',
    {
      title: 'Create project',
      description: 'A new project in the projects folder. Default 1920×1080 at 24 fps.',
      inputSchema: {
        name: z.string().min(1),
        width: z.number().int().min(16).max(8192).optional(),
        height: z.number().int().min(16).max(8192).optional(),
        fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(48), z.literal(50), z.literal(60)]).optional(),
        kind: z.enum(['film', 'ad', 'social', 'edit']).optional().describe('What it is for: shapes the app’s workspace'),
      },
    },
    async ({ name, width, height, fps, kind }) => {
      const settings = { ...(width ? { width } : {}), ...(height ? { height } : {}), ...(fps ? { fps, fpsAuto: false } : {}) }
      const p = await api<ProjectDetail>('POST', '/api/projects', { name, settings, ...(kind ? { kind } : {}) })
      session.projects.add(p.id)
      return json({ id: p.id, name: p.name, path: p.path, settings: p.settings, revision: p.revision })
    },
  )

  server.registerTool(
    'open_project',
    {
      title: 'Open project',
      description: 'Opens a project folder (.wildroom) from anywhere on this Mac, e.g. a copy from another machine.',
      inputSchema: { path: z.string().min(1).describe('Absolute path of the .wildroom folder') },
    },
    async ({ path }) => {
      const p = await api<ProjectDetail>('POST', '/api/projects/open', { path })
      session.projects.add(p.id)
      return json({ id: p.id, name: p.name, path: p.path, settings: p.settings })
    },
  )

  server.registerTool(
    'get_project',
    {
      title: 'Get project',
      description:
        'The project’s settings, timeline (every clip with id, start and duration in frames, lane, asset), markers, boards with their frames, story in brief and brand. raw: true adds the whole saved document (large).',
      inputSchema: { project: projectRef, raw: z.boolean().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ project, raw }) => {
      const p = await loadProject(await projectId(project))
      return json({ id: p.id, name: p.name, path: p.path, revision: p.revision, ...summarizeDoc(p.doc), ...(raw ? { doc: p.doc } : {}) })
    },
  )

  server.registerTool(
    'list_assets',
    {
      title: 'List assets',
      description: 'The project’s media: pictures, videos, sounds, fonts — ids to use in motion_import, add_to_timeline and generate.',
      inputSchema: {
        project: projectRef,
        kind: z.enum(['image', 'video', 'audio', 'font']).optional(),
        search: z.string().optional(),
        limit: z.number().int().min(1).max(500).default(100),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ project, kind, search, limit }) => {
      const id = await projectId(project)
      const q = new URLSearchParams({ ...(kind ? { kind } : {}), ...(search ? { q: search } : {}) })
      const assets = await api<AssetDTO[]>('GET', `/api/projects/${encodeURIComponent(id)}/assets${q.size ? `?${q}` : ''}`)
      return json({ total: assets.length, assets: assets.slice(0, limit).map(assetFacts) })
    },
  )

  server.registerTool(
    'view_asset',
    {
      title: 'Look at an asset',
      description: 'Shows a picture, or a video frame at at_seconds, so you can check a result. Sounds answer with their facts and words.',
      inputSchema: { asset: z.string().min(1), at_seconds: z.number().nonnegative().default(0), width: z.number().int().min(128).max(1536).default(768) },
      annotations: { readOnlyHint: true },
    },
    async ({ asset, at_seconds, width }) => {
      const dto = await api<AssetDTO>('GET', `/api/assets/${encodeURIComponent(asset)}`)
      const facts = { ...assetFacts(dto), ...(dto.alignment?.words?.length ? { transcript: dto.alignment.words.map((w) => w.text).join(' ') } : {}) }
      const image = await picture(asset, at_seconds, width)
      return { content: [{ type: 'text', text: JSON.stringify(facts, null, 2) }, ...(image ? [image] : [])] }
    },
  )

  server.registerTool(
    'list_models',
    {
      title: 'List models',
      description:
        'Generation models (image, video, speech, music, sfx…): id, provider, whether it is free and available now, and a price hint at default settings. Pass model for one model’s full parameters.',
      inputSchema: {
        kind: z.enum(['video', 'image', 'speech', 'dialogue', 'music', 'sfx', 'lipsync', 'upscale', 'foley', 'cutout', 'vectorize']).optional(),
        model: z.string().optional(),
        available_only: z.boolean().default(true),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ kind, model, available_only }) => {
      const demo = deps.settings.get().demoMode
      const providers = new Map((await api<ProviderStatus[]>('GET', '/api/settings/providers')).map((p) => [p.id, p]))
      const available = (m: ModelSpec) => {
        if (m.provider === 'mock') return demo
        const p = providers.get(m.provider)
        if (!p?.configured) return false
        const ready = p.models?.[m.id]
        return ready ? ready.ready : true
      }
      if (model) {
        const m = getModel(model)
        if (!m) throw new Error(`Unknown model ${model}`)
        return json({ id: m.id, label: m.label, vendor: m.vendor, provider: m.provider, kind: m.kind, description: m.description, free: isFreeModel(m), available: available(m), priceAtDefaultsUsd: priceHint(m), maxVariants: m.maxVariants ?? 1, params: paramFacts(m) })
      }
      const list = allModels()
        .filter((m) => (!kind || m.kind === kind) && (!available_only || available(m)) && (!m.demoOnly || demo))
        .map((m) => ({ id: m.id, label: m.label, provider: m.provider, kind: m.kind, free: isFreeModel(m), available: available(m), priceAtDefaultsUsd: priceHint(m) }))
      return json(list)
    },
  )

  server.registerTool(
    'estimate_cost',
    {
      title: 'Estimate cost',
      description: 'The price of a render with these settings (USD, all variants), without starting it.',
      inputSchema: { model: z.string().min(1), params: z.record(z.string(), z.unknown()).default({}), variants: z.number().int().min(1).max(8).default(1) },
      annotations: { readOnlyHint: true },
    },
    async ({ model, params, variants }) => {
      const m = getModel(model)
      if (!m) throw new Error(`Unknown model ${model}`)
      const est = await api<{ usd: number | null; detail: string; asOf: string }>('POST', '/api/generations/estimate', { modelId: model, params, variants })
      return json({ ...est, free: isFreeModel(m) })
    },
  )

  server.registerTool(
    'generate',
    {
      title: 'Generate',
      description:
        'Queues a render (picture, video, voice, music…) into the project. Free models (demo, local) start at once. A paid model first answers with its price and starts nothing: ask the user, then call again with confirm_usd (the amount they agreed to). Asset params (start frame, references) take asset ids of this project. Then get_job.',
      inputSchema: {
        project: projectRef,
        model: z.string().min(1).describe('A model id from list_models'),
        params: z.record(z.string(), z.unknown()).describe('The model’s parameters (list_models with model: its params), e.g. { "prompt": "…", "duration": 5 }'),
        variants: z.number().int().min(1).max(8).default(1),
        label: z.string().max(200).optional().describe('What to call the render and its media'),
        confirm_usd: z.number().positive().optional().describe('The spend the user agreed to for this call (paid models only)'),
      },
    },
    async ({ project, model, params, variants, label, confirm_usd }) => {
      const m = getModel(model)
      if (!m) throw new Error(`Unknown model ${model} (list_models)`)
      const parsed = parseParams(m, params)
      if (!parsed.ok) throw new Error(`${parsed.message}${parsed.errors ? ` — ${JSON.stringify(parsed.errors)}` : ''}`)
      const id = await projectId(project)
      const est = await api<{ usd: number | null; detail: string }>('POST', '/api/generations/estimate', { modelId: model, params, variants })
      const verdict = checkSpend({
        free: isFreeModel(m),
        estimateUsd: est.usd,
        confirmUsd: confirm_usd,
        spentUsd: session.spentUsd,
        capUsd: deps.settings.get().mcp.sessionCapUsd,
      })
      if (!verdict.run) return json({ started: false, reason: verdict.reason, message: verdict.message, estimateUsd: est.usd, priceDetail: est.detail })
      // Counted before the render is queued, so calls made at the same time can't all pass the cap together.
      session.spentUsd += verdict.chargeUsd
      let jobs: GenerationDTO[]
      try {
        jobs = await api<GenerationDTO[]>('POST', '/api/generations', { projectId: id, modelId: model, params, variants, ...(label ? { label } : {}) })
      } catch (err) {
        session.spentUsd -= verdict.chargeUsd
        throw err
      }
      return json({ started: true, chargedUsd: verdict.chargeUsd, sessionSpentUsd: round(session.spentUsd, 3), jobs: jobs.map(jobFacts), next: 'get_job with wait_seconds to wait for each result' })
    },
  )

  server.registerTool(
    'get_job',
    {
      title: 'Get job',
      description: 'A render’s status; waits up to wait_seconds for it to finish. A finished picture or video is shown to you (preview: false to skip).',
      inputSchema: { job: z.string().min(1), wait_seconds: z.number().int().min(0).max(300).default(0), preview: z.boolean().default(true) },
      annotations: { readOnlyHint: true },
    },
    async ({ job, wait_seconds, preview }, extra) => {
      const until = Date.now() + wait_seconds * 1000
      let j = await api<GenerationDTO>('GET', `/api/generations/${encodeURIComponent(job)}`)
      while (!TERMINAL_JOB_STATUSES.includes(j.status) && Date.now() < until && !extra.signal.aborted) {
        await new Promise((r) => setTimeout(r, 1000))
        j = await api<GenerationDTO>('GET', `/api/generations/${encodeURIComponent(job)}`)
      }
      const content: CallToolResult['content'] = [{ type: 'text', text: JSON.stringify(jobFacts(j), null, 2) }]
      if (preview && j.status === 'succeeded') {
        for (const assetId of j.outputAssetIds.slice(0, 4)) {
          const image = await picture(assetId, 0, 640).catch(() => undefined)
          if (image) content.push(image)
        }
      }
      return { content }
    },
  )

  server.registerTool(
    'list_jobs',
    {
      title: 'List jobs',
      description: 'The project’s renders, newest first (active_only for those queued or running).',
      inputSchema: { project: projectRef, active_only: z.boolean().default(false), limit: z.number().int().min(1).max(300).default(30) },
      annotations: { readOnlyHint: true },
    },
    async ({ project, active_only, limit }) => {
      const id = await projectId(project)
      const jobs = await api<GenerationDTO[]>('GET', `/api/projects/${encodeURIComponent(id)}/generations${active_only ? '?active=1' : ''}`)
      return json(jobs.slice(0, limit).map(jobFacts))
    },
  )

  server.registerTool(
    'cancel_job',
    { title: 'Cancel job', description: 'Cancels a queued or running render.', inputSchema: { job: z.string().min(1) } },
    async ({ job }) => json(jobFacts(await api<GenerationDTO>('POST', `/api/generations/${encodeURIComponent(job)}/cancel`, {}))),
  )

  server.registerTool(
    'temp_voice',
    {
      title: 'Temporary voice-over',
      description: 'A free voice-over spoken by a macOS voice, for timing an animatic or explainer before paid TTS. Returns the audio asset.',
      inputSchema: {
        project: projectRef,
        text: z.string().min(1),
        voice: z.string().optional().describe('A macOS voice name; default: a Polish voice for Polish text, else the system voice'),
        rate: z.number().int().min(90).max(400).optional().describe('Words per minute'),
        name: z.string().optional(),
      },
    },
    async ({ project, text: line, voice, rate, name }) => {
      const id = await projectId(project)
      const asset = await api<AssetDTO>('POST', `/api/projects/${encodeURIComponent(id)}/temp-voice`, { text: line, voice, rate, name })
      return json(assetFacts(asset))
    },
  )

  server.registerTool(
    'get_motion_import_guide',
    {
      title: 'Motion import guide',
      description: 'The motion-import format (boards, elements, motion clips, tracks and keys, voice-over timing, markers, brand) with its JSON schema. Read it before writing a motion_import.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      const doc = readDoc('motion-import.md')
      const schema = z.toJSONSchema(motionImportSchema, { io: 'input', unrepresentable: 'any' })
      return text(`${doc ?? '(docs/motion-import.md is not shipped with this build: the schema below is the format)'}\n\n## JSON schema\n\n\`\`\`json\n${JSON.stringify(schema)}\n\`\`\``)
    },
  )

  server.registerTool(
    'motion_import',
    {
      title: 'Motion import',
      description:
        'Builds an explainer or motion graphics in one go: media and fonts from files on this Mac, boards with frames and elements, motion clips with keyframed tracks, sound, markers and brand — saved as one revision (an open editor reloads). Pass the JSON as import, or the path of a .json file (relative media paths are read from its folder). Format: get_motion_import_guide.',
      inputSchema: {
        project: projectRef,
        import: z.record(z.string(), z.unknown()).optional().describe('The motion-import JSON'),
        file: z.string().optional().describe('Absolute path of a motion-import .json file instead'),
        base_dir: z.string().optional().describe('Folder relative media/font paths in import are read from'),
      },
    },
    async ({ project, import: inline, file, base_dir }) => {
      if (!inline === !file) throw new Error('Pass either import (the JSON) or file (its path)')
      let body: Record<string, unknown>
      let base = base_dir
      if (file) {
        const path = allowedFile(file, importRoots(deps.env))
        body = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
        base ??= dirname(path)
      } else body = { ...inline! }
      delete body.project
      if (base) {
        for (const list of [body.media, body.fonts]) {
          if (!Array.isArray(list)) continue
          for (const m of list as Array<{ path?: unknown }>) if (m && typeof m.path === 'string' && !isAbsolute(m.path)) m.path = resolve(base, m.path)
        }
      }
      const id = await projectId(project)
      return json(await api<MotionImportResult>('POST', `/api/projects/${encodeURIComponent(id)}/motion-import`, body))
    },
  )

  server.registerTool(
    'import_media',
    {
      title: 'Import media',
      description: 'Copies pictures, videos, sounds or fonts from this Mac into the project (home folders, the projects folder or temp). Returns their asset ids.',
      inputSchema: { project: projectRef, paths: z.array(z.string().min(1)).min(1).max(100).describe('Absolute file paths'), role: z.string().optional().describe('For sounds: dialogue, music, effects…') },
    },
    async ({ project, paths, role }) => {
      const id = await projectId(project)
      const fontExt = /\.(ttf|otf|woff2?)$/i
      const media = paths.filter((p) => !fontExt.test(p)).map((path, i) => ({ key: `m${i}`, path, ...(role ? { role } : {}) }))
      const fonts = paths.filter((p) => fontExt.test(p)).map((path, i) => ({ key: `f${i}`, path }))
      const out = await api<MotionImportResult>('POST', `/api/projects/${encodeURIComponent(id)}/motion-import`, { version: 1, media, fonts })
      return json({
        assets: media.map((m) => ({ path: m.path, assetId: out.assets[m.key] })),
        fonts: fonts.map((f) => ({ path: f.path, family: out.fonts[f.key] })),
        warnings: out.warnings,
      })
    },
  )

  const at = z
    .union([z.literal('end'), z.number().int().nonnegative(), z.object({ clip: z.string(), offset: z.number().int().default(0) })])
    .default('end')
    .describe('"end" (after the storyline), a frame, or { clip: <key of an earlier entry>, offset }')

  server.registerTool(
    'add_to_timeline',
    {
      title: 'Add to timeline',
      description:
        'Places assets of the project on the timeline, in order: "end" with no lane appends to the storyline; a lane (>0 above, <0 below) connects it. Sounds go below by default. Frames at the project fps.',
      inputSchema: {
        project: projectRef,
        clips: z
          .array(
            z.object({
              asset: z.string().min(1).describe('Asset id'),
              key: z.string().regex(/^[\w.-]{1,64}$/).optional().describe('Name to refer to this entry in a later entry’s at'),
              at,
              lane: z.number().int().optional(),
              duration: z.number().int().positive().optional().describe('Frames: a picture’s length, or a shorter cut'),
              name: z.string().optional(),
              role: z.string().optional(),
            }),
          )
          .min(1)
          .max(200),
      },
    },
    async ({ project, clips }) => {
      const id = await projectId(project)
      const timeline = await Promise.all(
        clips.map(async (c) => {
          const a = await api<AssetDTO>('GET', `/api/assets/${encodeURIComponent(c.asset)}`)
          if (a.kind === 'font') throw new Error(`${c.asset} is a font, not media`)
          return { type: a.kind, media: c.asset, at: c.at, ...(c.key ? { key: c.key } : {}), ...(c.lane !== undefined ? { lane: c.lane } : {}), ...(c.duration ? { duration: c.duration } : {}), ...(c.name ? { name: c.name } : {}), ...(c.role ? { role: c.role } : {}) }
        }),
      )
      const out = await api<MotionImportResult>('POST', `/api/projects/${encodeURIComponent(id)}/motion-import`, { version: 1, timeline })
      return json({ revision: out.revision, clips: out.clips, warnings: out.warnings })
    },
  )

  server.registerTool(
    'edit_timeline',
    {
      title: 'Edit timeline',
      description:
        'Changes clips by id (get_project lists them), in order, as one revision: remove {ids, mode: ripple|gap}, move {id, frame, lane?}, trim {id, edge: start|end, delta}, blade {frame, ids?}, speed {id, speed}, set {id, patch: name/enabled/video/audio/text/style/tracks/camera…}, marker {frame, name, kind}, remove_marker {id}.',
      inputSchema: { project: projectRef, ops: z.array(timelineOpSchema).min(1).max(200) },
    },
    async ({ project, ops }) => {
      const id = await projectId(project)
      const saved = await api<SaveDocResponse>('POST', `/api/projects/${encodeURIComponent(id)}/timeline-ops`, { ops })
      const p = await loadProject(id)
      return json({ revision: saved.revision, timeline: summarizeDoc(p.doc).timeline })
    },
  )

  server.registerTool(
    'set_story',
    {
      title: 'Set story',
      description:
        'Writes the project’s story (title, logline, script, style, characters, places, chapters, scenes, shots) — what the Plan step shows. Fields given replace those in the saved story; the rest stay. Shots need an id and a description.',
      inputSchema: { project: projectRef, story: z.record(z.string(), z.unknown()) },
    },
    async ({ project, story }) => {
      const id = await projectId(project)
      const p = await loadProject(id)
      const base: StoryDoc = p.doc.story ?? { script: '', style: '', characters: [], shots: [] }
      const merged = sanitizeStory({ ...base, ...(story as Partial<StoryDoc>) } as StoryDoc)
      if (!merged) throw new Error('story.shots must be a list')
      const saved = await api<SaveDocResponse>('PUT', `/api/projects/${encodeURIComponent(id)}/doc`, { doc: { ...p.doc, story: merged }, baseRevision: p.revision })
      deps.events.publish({ type: 'project.doc.saved', projectId: id, revision: saved.revision, source: 'import' })
      return json({ revision: saved.revision, story: summarizeDoc({ ...p.doc, story: merged }).story })
    },
  )

  const DIRECTOR_PATHS = {
    plan: '/api/director/plan',
    explainer: '/api/director/explainer',
    write_script: '/api/director/write-script',
    outline: '/api/director/outline',
    scene_shots: '/api/director/scene-shots',
    breakdown: '/api/director/breakdown',
    asset_set: '/api/director/asset-set',
    enhance_prompt: '/api/director/enhance',
  } as const
  type DirectorAction = keyof typeof DIRECTOR_PATHS

  server.registerTool(
    'director',
    {
      title: 'AI Director',
      description:
        'The app’s AI Director (its own text model): plan (chat → a plan of steps), explainer (scenes with voice-over and animations), write_script (idea → screenplay), outline (script → cast, places, chapters, scenes), scene_shots (one scene’s shots), breakdown, asset_set (brief → brand/web/social images), enhance_prompt. request is that endpoint’s body. Plans only: nothing is generated or saved. With an API key set it spends a few cents of text tokens: confirm: true after the user agrees; in demo mode without keys it answers from local rules for free.',
      inputSchema: {
        action: z.enum(Object.keys(DIRECTOR_PATHS) as [DirectorAction, ...DirectorAction[]]),
        request: z.record(z.string(), z.unknown()),
        confirm: z.boolean().optional(),
      },
    },
    async ({ action, request, confirm }) => {
      const keys = directorCredentials(deps)
      const paid = Boolean(keys.anthropic || keys.openrouter || keys.fal)
      if (paid && !confirm) {
        return json({ started: false, reason: 'needs_confirmation', message: `The Director runs ${keys.choice?.model ?? 'a text model'} on the user’s API key (usually a few cents). Ask the user, then call again with confirm: true.` })
      }
      return json(await api('POST', DIRECTOR_PATHS[action], request))
    },
  )

  /** The app's window opens the project in the editor (the first window that can). */
  const openInApp = (id: string, claimMs = 5000) => deps.appRequests.ask('open-project', id, {}, { claimMs, doneMs: 30_000 })

  server.registerTool(
    'open_in_app',
    {
      title: 'Open in the app',
      description: 'Shows the project in the app’s editor window, so the user can watch and play what you built.',
      inputSchema: { project: projectRef },
    },
    async ({ project }) => {
      const id = await projectId(project)
      await openInApp(id)
      return json({ opened: id })
    },
  )

  server.registerTool(
    'export_video',
    {
      title: 'Export video',
      description:
        'Exports the project’s open timeline to an MP4 (H.264, project size, loudness -14 LUFS, captions burnt in) with the app’s own renderer, into the project’s Assets. The app window opens the project first if needed and must stay open while it renders. Waits until done (up to 30 min) and returns the file.',
      inputSchema: { project: projectRef, name: z.string().max(200).optional().describe('The export’s name (default: the project’s)') },
    },
    async ({ project, name }) => {
      const id = await projectId(project)
      const options = name ? { name } : {}
      const timing = { claimMs: 3000, doneMs: 30 * 60_000 }
      let result: { assetId?: string }
      try {
        result = await deps.appRequests.ask('export', id, options, timing)
      } catch (err) {
        if (!(err instanceof NotClaimedError)) throw err
        // No editor has it open: open it, then ask again (the editor takes it and starts once the project has loaded).
        await openInApp(id)
        try {
          result = await deps.appRequests.ask('export', id, options, { ...timing, claimMs: 20_000 })
        } catch (again) {
          if (!(again instanceof NotClaimedError)) throw again
          throw new Error('The editor did not take the export: if its Export window is open (or already exporting), close it or let it finish, then try again')
        }
      }
      if (!result?.assetId) throw new Error('The app finished the export without saying which file it made')
      const asset = await api<AssetDTO>('GET', `/api/assets/${encodeURIComponent(result.assetId)}`)
      const row = deps.media.get(asset.id)
      const image = await picture(asset.id, 1, 640).catch(() => undefined)
      const facts = { ...assetFacts(asset), ...(row ? { path: deps.media.originalPath(row) } : {}) }
      return { content: [{ type: 'text', text: JSON.stringify(facts, null, 2) }, ...(image ? [image] : [])] }
    },
  )
}
