import type { PlanStepOf, StepProgress } from '@shared/director/plan'
import { fitParams, nearestAspect } from '@shared/models/fit'
import type { ModelSpec, ParamValues } from '@shared/models/types'
import { type ExplainerScene, capPictures, estimateWords, explainerEstimate, explainerStyle, layoutScene, sceneFrames, sceneMotion } from '@shared/motion/explainer'
import { defaultValues } from '@shared/models/params'
import { toolModel } from '@/features/generate/resultActions'
import * as ops from '@shared/timeline'
import { flicksToSeconds } from '@shared/time/flicks'
import type { AlignedWord, AssetDTO } from '@shared/types/assets'
import { hasBrand, primaryColor } from '@shared/types/brand'
import type { CanvasAssetItem, Rect } from '@shared/types/canvas'
import type { MotionClip } from '@shared/types/project-doc'
import { fittedTextHeight } from '@/features/canvas/textFit'
import { addBoard, editBoard, newItemId } from '@/features/canvas/useCanvasDoc'
import type { useStory } from '@/features/story/useStory'
import { api } from '@/lib/api'
import { formatUsd } from '@/lib/format'
import { useAssetsStore } from '@/stores/assets'
import { useJobsStore } from '@/stores/jobs'
import { useProjectStore } from '@/stores/project'
import type { RunContext, StepQuote } from './tools'

/**
 * The Director's explainer step: priced from its length before the scenes exist, then run — the scenes written, laid
 * out as frames on a new board, the pictures drawn into them, the voice-over recorded scene by scene, and the frames
 * put at the end of the timeline as motion clips whose elements come in on the narrator's words.
 */

type Step = PlanStepOf<'create-explainer'>
type Story = ReturnType<typeof useStory>

/** A voice is waited for this long at most. */
const VOICE_LIMIT_MS = 5 * 60_000

export function createExplainerTools(s: Story) {
  const project = useProjectStore()
  const jobs = useJobsStore()
  const assets = useAssetsStore()

  const frameSize = () => ({ w: project.doc.settings.width, h: project.doc.settings.height })
  const imageParams = (model: ModelSpec, prompt: string, r: { w: number; h: number }): ParamValues =>
    fitParams(model, { prompt, aspectRatio: nearestAspect(model, r.w, r.h) })
  const voiceParams = (model: ModelSpec, text: string, voiceId?: string): ParamValues => fitParams(model, { text, ...(voiceId ? { voiceId } : {}) })
  /** The narrator: the first voice in the ElevenLabs account (the mock voice needs none). */
  async function narrator(model: ModelSpec): Promise<string | undefined> {
    if (model.provider === 'mock') return undefined
    const cast = s.story.value.characters.find((c) => c.voiceId)?.voiceId
    if (cast) return cast
    try {
      return (await api.voices.list()).voices[0]?.id
    } catch {
      return undefined
    }
  }

  /**
   * The step priced from its length: the Director's writing, about a picture a scene (cut out of its background in
   * the looks that want it), the voice-over's characters.
   */
  function quote(step: Step, text: StepQuote): StepQuote {
    const est = explainerEstimate(step.seconds)
    const image = s.modelFor('image')
    const cutout = explainerStyle(step.style).picture.cutout ? toolModel('cutout') : undefined
    const voice = s.modelFor('speech')
    let usd: number | null | undefined = text.usd
    const add = (v: number | null | undefined) => {
      if (v === null) usd = null
      else if (v !== undefined && usd !== null) usd = (usd ?? 0) + v
    }
    const look = explainerStyle(step.style)
    const parts = [text.detail, ...(look.id === 'default' ? [] : [`look: ${look.label}`])]
    let seconds = text.seconds
    if (image) {
      const params = imageParams(image, 'An illustration', frameSize())
      const one = image.estimateCost(params).usd
      add(one === null ? null : one * est.images)
      parts.push(`${est.images} × ${image.label}`)
      const each = image.estimateSeconds?.(params) ?? 60
      seconds += image.provider === 'local' ? each * est.images : each
      if (cutout) {
        const c = cutout.estimateCost(defaultValues(cutout)).usd
        add(c === null ? null : c * est.images)
        parts.push(`${est.images} × ${cutout.label} (cut-outs)`)
        seconds += 20
      }
    }
    if (voice) {
      add(voice.estimateCost(voiceParams(voice, 'x'.repeat(est.chars), 'voice')).usd)
      parts.push(`voice-over ≈ ${est.chars} characters · ${voice.label}`)
      seconds += 10
    } else parts.push('voice-over · free macOS voice')
    return {
      usd,
      free: usd === 0,
      seconds,
      detail: parts.join(' + '),
      count: est.images + est.scenes + 1,
      problems: [...text.problems, ...(image ? [] : ['No image model is ready: the frames get words and shapes only'])],
      runpod: image?.provider === 'runpod',
    }
  }

  /** Resolves with the finished job's first output (undefined when it failed, on Stop or after `limitMs`). */
  function finished(id: string, ctx: Pick<RunContext, 'stopped'>, limitMs: number): Promise<string | undefined> {
    return new Promise((resolve) => {
      const started = Date.now()
      const check = () => {
        const job = jobs.byId[id]
        if (job && jobs.isTerminal(job)) return done(job.status === 'succeeded' ? job.outputAssetIds[0] : undefined)
        if (ctx.stopped() || Date.now() - started > limitMs) return done(undefined)
      }
      const done = (v: string | undefined) => {
        clearInterval(timer)
        off()
        resolve(v)
      }
      const off = jobs.onFinished(check)
      const timer = setInterval(check, 1000)
      check()
    })
  }

  interface Voice {
    asset?: AssetDTO
    words: AlignedWord[]
    seconds: number
  }

  /**
   * Each scene's voice-over: ElevenLabs (its words timed as it speaks), else the free macOS voice (words spread over
   * its length); a scene whose voice fails keeps a length read from its words, and no sound. The voices start right
   * away (ahead of the pictures in the queue: the timeline waits for them, not for the pictures); `wait` collects them.
   */
  async function startVoices(scenes: ExplainerScene[], title: string): Promise<{ wait: (ctx: RunContext) => Promise<{ voices: Voice[]; via: string }> }> {
    const fallback = (sc: ExplainerScene): Voice => {
      const seconds = Math.max(2, sc.voiceover.split(/\s+/).length / 2.5)
      return { words: estimateWords(sc.voiceover, seconds), seconds }
    }
    const fromAsset = async (id: string, sc: ExplainerScene): Promise<Voice> => {
      const asset = await assets.whenReady(id)
      const seconds = asset.durationFlicks ? flicksToSeconds(asset.durationFlicks) : fallback(sc).seconds
      return { asset, words: asset.alignment?.words?.length ? asset.alignment.words : estimateWords(sc.voiceover, seconds), seconds }
    }
    let done = 0
    const tick = (ctx: RunContext) => ctx.progress({ note: `Recording the voice-over · ${done} of ${scenes.length}`, done, total: scenes.length })
    const model = s.modelFor('speech')
    const voiceId = model ? await narrator(model) : undefined
    if (model && (voiceId || model.provider === 'mock')) {
      const created = await Promise.all(
        // A voice refused (credit, rate limit) leaves its scene timed from its words, the others still recorded.
        scenes.map(async (sc, i) =>
          (await jobs.create({ projectId: project.id!, modelId: model.id, params: voiceParams(model, sc.voiceover, voiceId), label: `${title} · voice ${i + 1}` }).catch(() => []))[0],
        ),
      )
      return {
        wait: async (ctx) => {
          tick(ctx)
          const voices = await Promise.all(
            scenes.map(async (sc, i) => {
              const id = created[i] ? await finished(created[i]!.id, ctx, VOICE_LIMIT_MS) : undefined
              const v = id ? await fromAsset(id, sc).catch(() => fallback(sc)) : fallback(sc)
              done++
              tick(ctx)
              return v
            }),
          )
          return { voices, via: model.label }
        },
      }
    }
    return {
      wait: async (ctx) => {
        tick(ctx)
        const voices: Voice[] = []
        for (const [i, sc] of scenes.entries()) {
          if (ctx.stopped()) break
          try {
            const asset = await api.tempVoice.create(project.id!, { text: sc.voiceover, name: `${title} · voice ${i + 1}` })
            voices.push(await fromAsset(asset.id, sc))
          } catch {
            voices.push(fallback(sc))
          }
          done++
          tick(ctx)
        }
        while (voices.length < scenes.length) voices.push(fallback(scenes[voices.length]!))
        return { voices, via: 'macOS temp voice' }
      },
    }
  }

  async function run(step: Step, approved: StepQuote | undefined, ctx: RunContext): Promise<StepProgress> {
    const pid = project.id
    if (!pid) return { state: 'failed', note: 'No project is open' }
    ctx.progress({ note: 'Writing the scenes…' })
    const brand = hasBrand(project.doc.brand) ? project.doc.brand : undefined
    const res = await api.director.explainer({
      topic: step.topic,
      seconds: step.seconds,
      ...(step.style ? { style: step.style } : {}),
      ...(brand ? { brand: { name: brand.name, style: brand.styleText, colors: brand.colors.map((c) => c.hex) } } : {}),
    })
    if (ctx.stopped() || project.id !== pid) return { state: 'stopped', note: 'Stopped before anything was made' }
    // No more pictures than were priced: the writer may plan a few more than the quote's count.
    const ex = capPictures(res.explainer, explainerEstimate(step.seconds).images)
    const style = explainerStyle(step.style)

    // The pictures and the voice-over, priced again now that the scenes exist (the writer may say more than was quoted).
    const image = s.modelFor('image')
    const speech = s.modelFor('speech')
    const size = frameSize()
    const pictures = image ? ex.scenes.flatMap((sc) => sc.elements.filter((e) => e.kind === 'image')).length : 0
    if (approved?.usd != null) {
      const one = image ? image.estimateCost(imageParams(image, 'An illustration', size)).usd : 0
      const chars = ex.scenes.reduce((n, sc) => n + sc.voiceover.length, 0)
      const spoken = speech ? speech.estimateCost(voiceParams(speech, 'x'.repeat(chars), 'voice')).usd : 0
      const usd = one == null || spoken == null ? undefined : one * pictures + spoken
      if (usd !== undefined && usd > approved.usd * 1.2 + 0.05)
        return { state: 'stopped', note: `Its ${pictures} pictures and ${chars} characters of voice-over now cost ${formatUsd(usd)}, more than the ${formatUsd(approved.usd)} approved — ask again to re-plan it` }
    }

    // The board: a frame per scene, three to a row, in the project's shape and the chosen look (the plain look takes
    // the brand's colour). Keyed elements carry over from scene to scene.
    const theme = style.id === 'default' ? { ...style, accent: primaryColor(brand) ?? style.accent } : style
    const gap = Math.round(size.w * 0.08)
    const shared = new Map()
    const layouts = ex.scenes.map((sc, i) =>
      layoutScene(sc, { x: (i % 3) * (size.w + gap), y: Math.floor(i / 3) * (size.h + gap), w: size.w, h: size.h }, theme, newItemId, fittedTextHeight, shared),
    )
    const boardId = addBoard(`Explainer · ${ex.title}`)
    editBoard(boardId, 'Explainer: lay out the scenes', (b) => b.items.push(...layouts.flatMap((l) => [l.frame, ...l.items])))
    const voicing = await startVoices(ex.scenes, ex.title)

    // Pictures into their frames (they fill in as they finish; the clips show them as soon as they do). A picture kept
    // across scenes (a key) is drawn once; in looks that cut pictures out, each is cut out as soon as it's drawn.
    let started = 0
    if (image) {
      const links = new Map<string, string>()
      const byKey = new Map<string, string>()
      for (const l of layouts) {
        for (const item of l.items) {
          if (item.kind !== 'asset' || !item.planned) continue
          const key = l.keyOf[item.id]
          const again = key ? byKey.get(key) : undefined
          if (again) {
            links.set(item.id, again)
            continue
          }
          const rect: Rect = item
          const prompt = [item.planned.prompt, style.imageStyle, ex.style].filter(Boolean).join('. ')
          // One refused (credit, rate limit, pod not ready) leaves its slot empty; the ones already drawing still land.
          const [job] = await jobs.create({ projectId: pid, modelId: image.id, params: imageParams(image, prompt, rect), label: `${ex.title} · ${l.frame.name}` }).catch(() => [])
          if (!job) continue
          links.set(item.id, job.id)
          if (key) byKey.set(key, job.id)
        }
      }
      started = new Set(links.values()).size
      if (style.picture.cutout) void cutOut(boardId, links, pid)
      editBoard(boardId, 'Explainer: pictures', (b) => {
        for (const it of b.items) if (it.kind === 'asset' && links.has(it.id)) (it as CanvasAssetItem).generationId = links.get(it.id)
      })
      project.resolvePendingTakes()
    }

    // The voice-over, then the timeline: the scenes one after another, each lasting its line.
    const { voices, via } = await voicing.wait(ctx)
    if (project.id !== pid) return { state: 'stopped', note: 'The project closed — the board is there, the timeline was left as it was' }
    const fps = project.doc.settings.fps
    const clips: MotionClip[] = layouts.map((l, i) => {
      const duration = sceneFrames(voices[i]!.seconds, fps)
      const motion = sceneMotion(ex.scenes[i]!, l, voices[i]!.words, duration, fps, theme)
      const clip = ops.makeMotion({ boardId, frameId: l.frame.id, tracks: motion.tracks, newId: newItemId, duration, name: l.frame.name })
      return motion.camera ? { ...clip, camera: motion.camera } : clip
    })
    project.apply((draft, rctx) => {
      ops.appendToSpine(clips)(draft, rctx)
      const layout = ops.layoutTimeline(draft)
      const lead = Math.round(0.4 * draft.settings.fps)
      clips.forEach((c, i) => {
        const item = layout.spine.find((x) => x.id === c.id)
        const asset = voices[i]?.asset
        const media = asset && rctx.media?.(asset.id)
        if (!item || !asset || !media) return
        const voice = ops.makeMediaClip({ assetId: asset.id, media, fps: draft.settings.fps, role: 'dialogue', name: `${ex.scenes[i]!.title} · voice`, newId: rctx.newId })
        ops.connectAt(item.start + lead, [voice], -1)(draft, rctx)
      })
    }, 'Explainer: add to the timeline')
    const spoken = voices.filter((v) => v.asset).length
    return {
      state: 'done',
      note: `“${ex.title}” · ${ex.scenes.length} scenes on a new board and at the end of the timeline · ${spoken} of ${ex.scenes.length} voiced (${via})${started ? ` · ${started} pictures drawing` : ''}`,
      show: { workspace: 'edit' },
    }
  }

  /**
   * Each drawn picture cut out of its background (the Remove background tool), the board's items then showing the
   * cut-out (the look's duotone or mask applies to it). Runs on after the step is done, as pictures finish; a picture
   * that fails, or no cut-out model, leaves the drawn one.
   */
  async function cutOut(boardId: string, links: Map<string, string>, pid: string) {
    const model = toolModel('cutout')
    if (!model) return
    const items = new Map<string, string[]>()
    for (const [itemId, jobId] of links) items.set(jobId, [...(items.get(jobId) ?? []), itemId])
    const never = { stopped: () => project.id !== pid }
    await Promise.all(
      [...items].map(async ([jobId, itemIds]) => {
        const drawn = await finished(jobId, never, 20 * 60_000)
        if (!drawn || project.id !== pid) return
        // A finished picture is still being processed for a moment, and a tool can't take it until it is.
        if (!(await assets.whenReady(drawn).catch(() => undefined)) || project.id !== pid) return
        const [cut] = await jobs.create({ projectId: pid, modelId: model.id, params: { ...defaultValues(model), image: drawn }, label: 'Explainer · cut-out' }).catch(() => [])
        if (!cut) return
        // The drawn picture stays until the cut-out is there: one that fails leaves it, not an empty slot.
        const cutAsset = await finished(cut.id, never, 20 * 60_000)
        if (!cutAsset || project.id !== pid) return
        editBoard(boardId, 'Explainer: cut-out', (b) => {
          for (const it of b.items) if (it.kind === 'asset' && itemIds.includes(it.id)) Object.assign(it, { generationId: cut.id, assetId: cutAsset })
        })
      }),
    )
  }

  return { quote, run }
}
