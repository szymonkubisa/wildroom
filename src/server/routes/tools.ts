import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { nanoid } from 'nanoid'
import type { AssetDTO } from '../../shared/types/assets'
import type { GenKind, ProviderId } from '../../shared/types/jobs'
import type { AppDeps } from '../app'
import { toGenerationDTO } from '../jobs/worker'
import type { ProjectStore } from '../storage/projectStore'
import type { AssetRow, GenerationRow } from '../storage/records'
import { badRequest, notFound, nowIso, readJson } from '../http'
import {
  type ColorStats,
  colorStats,
  decodeMono,
  demoCleanVoice,
  demoTranscript,
  elevenIsolate,
  elevenTranscribe,
  frameJpeg,
  frameRgb,
  mixVoiceSample,
  reverseMedia,
  stillSsim,
} from '../services/analysis'
import { detectBeats } from '../services/beats'
import { describeMedia, locateSubjects, reviewContinuity } from '../services/director'
import { type LlmTarget, resolveTarget } from '../services/llm'
import { directorCredentials } from './director'

const FLICKS = 705_600_000

/** The ElevenLabs endpoints the tools call aren't catalog models: their records carry these ids. */
const ISOLATION_MODEL = 'elevenlabs-audio-isolation'
const SCRIBE_MODEL = 'elevenlabs-scribe-v1'

interface FrameRef {
  assetId: string
  seconds: number
}

/** A paid provider call a tool made (see `recordToolCall`). */
interface ToolCall {
  /** Which tool ran: `label` goes into params (History shows it), `id` into providerMeta. */
  tool: { id: string; label: string }
  modelId: string
  provider: ProviderId
  kind: GenKind
  label: string
  /** Shown under the call in History. Saved in the bundle: never a key. */
  params: Record<string, unknown>
  inputAssetIds: string[]
  outputAssetIds?: string[]
  /** What the provider was sent, summarised: no keys, audio and frames as references. */
  request: unknown
  response: unknown
  startedAt: string
}

/** Recorded text is kept whole up to this length (as the worker keeps a render's request). */
const TEXT_MAX = 20_000
const clip = (text: string) => (text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX)}… <${text.length} chars>` : text)
const round2 = (n: number) => Math.round(n * 100) / 100

/** A text-model call is recorded under the model the user picked, and the route (key) that ran it. */
const llmModel = (target: LlmTarget): { modelId: string; provider: ProviderId } => ({ modelId: target.model, provider: target.via })
const llmRequest = (target: LlmTarget) => ({ via: target.via, model: target.providerModel })
/** A frame sent to a model, as recorded: which asset, where and how wide (not the JPEG itself). */
const sentFrame = (ref: FrameRef, width: number) => ({ assetId: ref.assetId, seconds: round2(Number(ref.seconds) || 0), width })

/** Editor tools: reverse, voice isolation, transcription, beats, AI descriptions, frame stats and similarity, continuity, reframe. */
export function toolRoutes(deps: AppDeps) {
  const { media, env, settings, secrets } = deps
  const r = new Hono()
  const workDir = () => {
    const dir = join(env.tmpDir, 'tools')
    mkdirSync(dir, { recursive: true })
    return dir
  }
  const demo = () => settings.get().demoMode
  const creds = () => directorCredentials(deps)
  /**
   * The model that reads the frames, when one can run (Anthropic or OpenRouter key). With such a key set, a route that
   * can't run (e.g. pinned to a provider without a key) throws its own reason instead of being reported as a missing key.
   */
  const visionTarget = async (): Promise<LlmTarget | undefined> => {
    const keys = creds()
    if (!keys.anthropic && !keys.openrouter) return undefined
    return resolveTarget(keys, { vision: true })
  }

  /** An asset that isn't deleted — of `projectId` when given: projects don't share assets, another's is not found. */
  const load = (id: string | undefined, projectId?: string) => {
    const row = id ? media.get(id) : undefined
    if (!row || row.deletedAt || (projectId !== undefined && row.projectId !== projectId)) throw notFound('Asset')
    return row
  }
  /** The project a request's frames come from: all of one project, like the timeline they are taken from. */
  const projectOf = (refs: (FrameRef | undefined)[]): string => {
    const projectId = load(refs[0]?.assetId).projectId
    for (const ref of refs) load(ref?.assetId, projectId)
    return projectId
  }
  const seconds = (row: AssetRow) => (row.durationFlicks ?? 0) / FLICKS

  /**
   * A paid call made here, outside the job queue, is recorded in its project as a finished generation, as a render
   * is: the Budget chip counts it, History lists it and "What was sent" shows the request. No call has a USD price:
   * ElevenLabs bills credits (its catalog models record none either) and the text-model calls report no token usage.
   * Best effort: the call is paid and its result applied either way, so a record that can't be saved never fails it.
   */
  function recordToolCall(store: ProjectStore, call: ToolCall) {
    const now = nowIso()
    const row: GenerationRow = {
      id: nanoid(12),
      projectId: store.id,
      modelId: call.modelId,
      provider: call.provider,
      kind: call.kind,
      status: 'succeeded',
      progress: 1,
      label: call.label,
      paramsJson: JSON.stringify({ tool: call.tool.label, ...call.params }),
      providerTaskId: null,
      providerMetaJson: JSON.stringify({ tool: call.tool.id, inputAssetIds: call.inputAssetIds }),
      requestJson: JSON.stringify(call.request),
      responseJson: JSON.stringify(call.response),
      adapterVersion: null,
      errorJson: null,
      costEstimateUsd: null,
      costUsd: null,
      outputAssetIdsJson: JSON.stringify(call.outputAssetIds ?? []),
      variant: 0,
      batchId: null,
      queueOrder: null,
      attempts: 1,
      ...store.machine,
      nextPollAt: null,
      createdAt: call.startedAt,
      updatedAt: now,
      startedAt: call.startedAt,
      finishedAt: now,
    }
    try {
      // A failed write stays pending for the next flush (and counts while the project is open).
      if (!store.putGeneration(row, 'now')) store.putGeneration(row, 'soon')
      deps.registry.indexGeneration(store, row.id)
      deps.events.publish({ type: 'generation.upserted', generation: { ...toGenerationDTO(row), projectName: store.name } })
    } catch (err) {
      console.error(`[tools] could not record the ${call.tool.label.toLowerCase()} call`, err)
    }
  }

  function audioPath(row: AssetRow): string {
    if (!row.hasAudio) throw badRequest('This clip has no audio')
    const path = media.variantPath(row, 'audio')
    if (!path) throw badRequest('The audio is still being prepared — try again in a moment')
    return path
  }

  /** Where to read a frame: the proxy for video (t=0 aligned), the original for stills. */
  function frameSource(row: AssetRow): { path: string; still: boolean } {
    if (row.kind === 'image') return { path: media.originalPath(row), still: true }
    if (row.kind !== 'video') throw badRequest('Frames need a video or image asset')
    const proxy = media.variantPath(row, 'proxy')
    if (!proxy) throw badRequest('The video is still being prepared — try again in a moment')
    return { path: proxy, still: false }
  }

  async function jpegAt(ref: FrameRef, width = 640): Promise<Buffer> {
    const row = load(ref.assetId)
    const src = frameSource(row)
    const t = src.still ? 0 : Math.max(0, Math.min(ref.seconds, seconds(row) - 0.05))
    return frameJpeg(src.path, t, workDir(), width)
  }

  async function statsAt(ref: FrameRef): Promise<ColorStats> {
    const row = load(ref.assetId)
    const src = frameSource(row)
    const t = src.still ? 0 : Math.max(0, Math.min(ref.seconds, seconds(row) - 0.05))
    return colorStats(await frameRgb(src.path, t, workDir(), 96, src.still))
  }

  // ---------------------------------------------------------------- derived media

  // Derived media is held for the whole render: closing the editor meanwhile must not unmount the project.
  r.post('/projects/:projectId/assets/:id/reverse', async (c) => {
    const row = load(c.req.param('id'), c.req.param('projectId'))
    if (row.kind === 'image') throw badRequest('Stills have nothing to reverse')
    const project = deps.registry.require(c.req.param('projectId'))
    const out = join(workDir(), `${nanoid(8)}.${row.kind === 'audio' ? 'm4a' : 'mp4'}`)
    const asset = await deps.registry.holdDuring(project.id, async () => {
      await reverseMedia(media.originalPath(row), out, { hasVideo: row.kind === 'video', hasAudio: row.hasAudio, seconds: seconds(row) })
      return media.importFile(out, {
        name: `${row.name} (reversed)`,
        source: 'derived',
        projectId: project.id,
        parentIds: [row.id],
        role: row.role ?? undefined,
        meta: { reverseOf: row.id },
        move: true,
      })
    })
    return c.json(asset, 201)
  })

  // A character's voice sample for LTX's subject references: the spoken line over a quiet bed, as one WAV.
  r.post('/projects/:projectId/voice-sample', async (c) => {
    const body = await readJson<{ speechAssetId?: string; bedAssetId?: string; name?: string }>(c)
    if (!body.speechAssetId) throw badRequest('speechAssetId is required')
    const speech = load(body.speechAssetId, c.req.param('projectId'))
    const bed = body.bedAssetId ? load(body.bedAssetId, c.req.param('projectId')) : undefined
    for (const row of [speech, bed]) if (row && (row.kind === 'image' || !row.hasAudio)) throw badRequest(`${row.name} has no audio`)
    const project = deps.registry.require(c.req.param('projectId'))
    const out = join(workDir(), `${nanoid(8)}.wav`)
    const asset = await deps.registry.holdDuring(project.id, async () => {
      await mixVoiceSample(media.originalPath(speech), bed && media.originalPath(bed), out)
      return media.importFile(out, {
        name: body.name?.trim() || `${speech.name} (voice sample)`,
        source: 'derived',
        projectId: project.id,
        parentIds: [speech.id, ...(bed ? [bed.id] : [])],
        role: 'dialogue',
        keywords: ['voice-sample'],
        meta: { voiceSampleOf: speech.id },
        move: true,
      })
    })
    return c.json(asset, 201)
  })

  r.post('/projects/:projectId/assets/:id/isolate-voice', async (c) => {
    const row = load(c.req.param('id'), c.req.param('projectId'))
    const input = audioPath(row)
    const key = secrets.get('elevenlabs', 'apiKey')
    if (!key && !demo()) throw badRequest('Voice isolation needs an ElevenLabs key (Settings → Providers)')
    const project = deps.registry.require(c.req.param('projectId'))
    const opts = {
      name: `${row.name} (voice)`,
      source: 'derived' as const,
      projectId: project.id,
      parentIds: [row.id],
      role: 'dialogue',
      meta: { isolatedFrom: row.id, via: key ? 'elevenlabs' : 'local' },
    }
    // Held while the (paid) isolation runs, so its result and its record always have a project to land in.
    const asset: AssetDTO = await deps.registry.holdDuring(project.id, async () => {
      if (key) {
        const startedAt = nowIso()
        const audio = await elevenIsolate(key, input)
        let out: AssetDTO | undefined
        try {
          return (out = await media.importBuffer(audio, 'mp3', opts))
        } finally {
          // Paid even when saving the result fails.
          const dur = round2(seconds(row))
          recordToolCall(project, {
            tool: { id: 'isolate-voice', label: 'Voice isolation' },
            modelId: ISOLATION_MODEL,
            provider: 'elevenlabs',
            kind: 'speech',
            label: `Voice isolation – ${row.name}`,
            params: { input: row.name, seconds: dur },
            inputAssetIds: [row.id],
            outputAssetIds: out ? [out.id] : [],
            request: { endpoint: 'POST /v1/audio-isolation', audio: { assetId: row.id, name: row.name, seconds: dur } },
            response: { bytes: audio.length, ...(out ? { assetId: out.id } : {}) },
            startedAt,
          })
        }
      }
      const out = join(workDir(), `${nanoid(8)}.wav`)
      await demoCleanVoice(input, out)
      return media.importFile(out, { ...opts, move: true })
    })
    return c.json(asset, 201)
  })

  // ---------------------------------------------------------------- analysis stored on the asset

  r.post('/assets/:id/transcribe', async (c) => {
    const row = load(c.req.param('id'))
    const input = audioPath(row)
    const key = secrets.get('elevenlabs', 'apiKey')
    if (key) {
      const store = deps.registry.require(row.projectId)
      // Held while the (paid) transcription runs, so its result and its record have a project to land in.
      const dto = await deps.registry.holdDuring(store.id, async () => {
        const startedAt = nowIso()
        const res = await elevenTranscribe(key, input)
        const dur = round2(seconds(row))
        recordToolCall(store, {
          tool: { id: 'transcribe', label: 'Transcription' },
          modelId: SCRIBE_MODEL,
          provider: 'elevenlabs',
          kind: 'speech',
          label: `Transcription – ${row.name}`,
          params: { input: row.name, seconds: dur },
          inputAssetIds: [row.id],
          request: { endpoint: 'POST /v1/speech-to-text', model: 'scribe_v1', audio: { assetId: row.id, name: row.name, seconds: dur } },
          response: { language: res.language, words: res.words.length, text: clip(res.text) },
          startedAt,
        })
        return media.setMeta(row.id, { alignment: { words: res.words, source: 'transcription' }, transcriptLanguage: res.language })
      })
      return c.json(dto)
    }
    if (!demo()) throw badRequest('Transcription needs an ElevenLabs key (Settings → Providers)')
    return c.json(media.setMeta(row.id, { alignment: { words: demoTranscript(seconds(row)), source: 'demo-transcript' } }))
  })

  r.post('/assets/:id/beats', async (c) => {
    const row = load(c.req.param('id'))
    const rate = 11025
    const samples = await decodeMono(audioPath(row), rate, workDir())
    const res = detectBeats(samples, rate)
    if (!res.beats.length) throw badRequest('No steady beat found in this audio')
    return c.json(media.setMeta(row.id, { beats: res }))
  })

  r.post('/assets/:id/describe', async (c) => {
    const row = load(c.req.param('id'))
    if (row.kind !== 'image' && row.kind !== 'video') throw badRequest('Only video and image assets can be described')
    const dur = seconds(row)
    const refs = row.kind === 'image' ? [0] : [0.15, 0.5, 0.85].map((p) => p * dur)
    const dto = media.toDTO(row)
    const target = await visionTarget()
    if (target) {
      const store = deps.registry.require(row.projectId)
      const described = await deps.registry.holdDuring(store.id, async () => {
        const frames = await Promise.all(refs.map((s) => jpegAt({ assetId: row.id, seconds: s }, 512)))
        const startedAt = nowIso()
        const res = await describeMedia(frames, { name: row.name, prompt: dto.generation?.prompt }, creds())
        recordToolCall(store, {
          tool: { id: 'describe', label: 'AI description' },
          ...llmModel(target),
          kind: row.kind === 'image' ? 'image' : 'video',
          label: `AI description – ${row.name}`,
          params: { input: row.name, frames: frames.length },
          inputAssetIds: [row.id],
          request: { ...llmRequest(target), frames: refs.map((s) => sentFrame({ assetId: row.id, seconds: s }, 512)), name: row.name, prompt: dto.generation?.prompt },
          response: res,
          startedAt,
        })
        return media.setMeta(row.id, { description: res.description, aiTags: res.tags, describedBy: 'claude' })
      })
      return c.json(described)
    }
    if (!demo()) throw badRequest('AI descriptions need an Anthropic or OpenRouter key (Settings → Providers)')
    const stats = await statsAt({ assetId: row.id, seconds: refs[Math.floor(refs.length / 2)]! })
    return c.json(media.setMeta(row.id, { ...demoDescription(stats, row.name, dto.generation?.prompt), describedBy: 'local' }))
  })

  // ---------------------------------------------------------------- frame-level helpers for the editor

  r.post('/analysis/frame-stats', async (c) => {
    const body = await readJson<{ items: FrameRef[] }>(c)
    if (!Array.isArray(body.items) || !body.items.length || body.items.length > 24) throw badRequest('Send 1–24 frames')
    projectOf(body.items)
    return c.json(await Promise.all(body.items.map(statsAt)))
  })

  // How alike two stills of one project are (a shot's start and end keyframes): local and free, so nothing is recorded.
  r.post('/analysis/frame-similarity', async (c) => {
    const body = await readJson<{ a?: string; b?: string }>(c)
    if (typeof body.a !== 'string' || typeof body.b !== 'string') throw badRequest('Send the two assets to compare as a and b')
    const a = load(body.a)
    const b = load(body.b, a.projectId)
    const ssim = await stillSsim(frameSource(a).path, frameSource(b).path)
    return c.json({ ssim: Math.round(ssim * 10_000) / 10_000 })
  })

  r.post('/director/continuity', async (c) => {
    const body = await readJson<{ cuts: { cut: number; outgoing: FrameRef; incoming: FrameRef; prompt?: string; label?: string }[] }>(c)
    if (!Array.isArray(body.cuts) || !body.cuts.length) throw badRequest('There are no cuts to check')
    const cuts = body.cuts.slice(0, 40)
    const projectId = projectOf(cuts.flatMap((cut) => [cut?.outgoing, cut?.incoming]))
    const target = await visionTarget()
    if (target) {
      const store = deps.registry.require(projectId)
      const issues = await deps.registry.holdDuring(store.id, async () => {
        const frames = await Promise.all(
          cuts.map(async (cut) => ({ ...cut, outgoing: await jpegAt(cut.outgoing, 512), incoming: await jpegAt(cut.incoming, 512) })),
        )
        const startedAt = nowIso()
        const found = await reviewContinuity(frames, creds())
        recordToolCall(store, {
          tool: { id: 'continuity', label: 'Continuity check' },
          ...llmModel(target),
          kind: 'video',
          label: `Continuity check – ${cuts.length} cut${cuts.length === 1 ? '' : 's'}`,
          params: { cuts: cuts.length },
          inputAssetIds: [...new Set(cuts.flatMap((cut) => [cut.outgoing.assetId, cut.incoming.assetId]))],
          request: {
            ...llmRequest(target),
            cuts: cuts.map(({ cut, outgoing, incoming, prompt, label }) => ({
              cut,
              label,
              outgoing: sentFrame(outgoing, 512),
              incoming: sentFrame(incoming, 512),
              prompt: prompt && clip(prompt),
            })),
          },
          response: { issues: found },
          startedAt,
        })
        return found
      })
      return c.json({ via: 'claude', issues })
    }
    if (!demo()) throw badRequest('The continuity check needs an Anthropic or OpenRouter key (Settings → Providers)')
    const issues = []
    for (const cut of cuts) {
      const [a, b] = await Promise.all([statsAt(cut.outgoing), statsAt(cut.incoming)])
      issues.push(...demoContinuity(cut.cut, a, b))
    }
    return c.json({ via: 'local', issues })
  })

  r.post('/director/subjects', async (c) => {
    const body = await readJson<{ items: FrameRef[] }>(c)
    if (!Array.isArray(body.items) || !body.items.length || body.items.length > 40) throw badRequest('Send 1–40 frames')
    const projectId = projectOf(body.items)
    const target = await visionTarget()
    if (target) {
      const store = deps.registry.require(projectId)
      const points = await deps.registry.holdDuring(store.id, async () => {
        const frames = await Promise.all(body.items.map((ref) => jpegAt(ref, 384)))
        const startedAt = nowIso()
        const found = await locateSubjects(frames, creds())
        recordToolCall(store, {
          tool: { id: 'subjects', label: 'Subject tracking' },
          ...llmModel(target),
          kind: 'video',
          label: `Subject tracking – ${frames.length} frame${frames.length === 1 ? '' : 's'}`,
          params: { frames: frames.length },
          inputAssetIds: [...new Set(body.items.map((ref) => ref.assetId))],
          request: { ...llmRequest(target), frames: body.items.map((ref) => sentFrame(ref, 384)) },
          response: { points: found },
          startedAt,
        })
        return found
      })
      return c.json({ via: 'claude', points })
    }
    const stats = await Promise.all(body.items.map(statsAt))
    return c.json({ via: 'local', points: stats.map((s) => ({ ...s.highlight, label: 'brightest area' })) })
  })

  return r
}

/** Demo-mode description from colour statistics and the clip's name/prompt. */
function demoDescription(s: ColorStats, name: string, prompt?: string) {
  const [r, , b] = s.mean
  const tone = r - b > 0.06 ? 'warm' : b - r > 0.06 ? 'cool' : 'neutral'
  const light = s.lumaMean > 0.6 ? 'bright' : s.lumaMean < 0.25 ? 'dark' : 'mid-toned'
  const contrast = s.lumaStd > 0.25 ? 'high-contrast' : s.lumaStd < 0.12 ? 'flat' : 'balanced'
  const color = s.saturation > 0.45 ? 'vivid' : s.saturation < 0.15 ? 'muted' : 'natural'
  const words = `${name} ${prompt ?? ''}`
    .toLowerCase()
    .split(/[^a-ząćęłńóśźż0-9]+/)
    .filter((w) => w.length > 3)
  return {
    description: `${light[0]!.toUpperCase()}${light.slice(1)}, ${tone}, ${contrast} frame with ${color} colour.${prompt ? ` Generated from: ${prompt.slice(0, 160)}` : ''}`,
    aiTags: [...new Set([light, tone, contrast, color, ...words])].slice(0, 15),
  }
}

/** Demo-mode continuity: flags big jumps in brightness, colour cast or saturation across a cut. */
function demoContinuity(cut: number, a: ColorStats, b: ColorStats) {
  const issues: { cut: number; severity: 'low' | 'medium' | 'high'; category: string; note: string; fix: string }[] = []
  const dl = b.lumaMean - a.lumaMean
  if (Math.abs(dl) > 0.18) {
    issues.push({
      cut,
      severity: Math.abs(dl) > 0.3 ? 'high' : 'medium',
      category: 'lighting',
      note: `Brightness jumps ${dl > 0 ? 'up' : 'down'} by ${Math.round(Math.abs(dl) * 100)}% across the cut.`,
      fix: `Match the ${dl > 0 ? 'darker' : 'brighter'} exposure and lighting of the previous shot.`,
    })
  }
  const castA = a.mean[0] - a.mean[2]
  const castB = b.mean[0] - b.mean[2]
  if (Math.abs(castB - castA) > 0.1) {
    issues.push({
      cut,
      severity: 'medium',
      category: 'color',
      note: `Colour temperature changes from ${castA > 0 ? 'warm' : 'cool'} to ${castB > 0 ? 'warm' : 'cool'}.`,
      fix: `Keep the ${castA > 0 ? 'warm, golden' : 'cool, bluish'} colour grade of the previous shot.`,
    })
  }
  if (Math.abs(b.saturation - a.saturation) > 0.2) {
    issues.push({ cut, severity: 'low', category: 'color', note: 'Saturation differs noticeably between the shots.', fix: 'Match the colour saturation of the previous shot.' })
  }
  return issues
}
