import { fitParams } from '@shared/models/fit'
import type { ModelSpec } from '@shared/models/types'
import { endCheckFresh } from '@shared/story/endFrame'
import { insertShot } from '@shared/story/structure'
import type { AssetDTO } from '@shared/types/assets'
import type { StoryCharacter, StoryDoc, StoryShot } from '@shared/types/story'
import { nanoid } from 'nanoid'
import { shallowReactive } from 'vue'
import { toast } from 'vue-sonner'
import { type CoverageAngle, coveragePrompt } from '@/features/generate/coverage'
import { api, errorMessage } from '@/lib/api'
import { lookOf, titleCase } from './cast'
import { splitAtEndFrame } from './endFrame'
import { CONTINUE_FROM_REFERENCE, type KeyframeRef, continuityRefs, imagePrompt, keyframeRefs, videoRefPrompt, withLegend } from './references'
import type { StoryCore } from './storyCore'
import type { StoryCuts } from './storyCuts'
import { inFlight, isDead } from './storyMedia'
import type { Planned, StoryRunner } from './storyRunner'

/**
 * Stills: a shot's keyframe and end frame — planned with their references, picked, restored and removed — the chained
 * stills a batch draws one after another, keyframes continued from the previous shot, and the characters' LTX video
 * references.
 */

const KEYFRAME_HISTORY = 8

/** Start/end pairs measured (or being measured) this session, by "startId endId": each pair is compared once. */
const endChecks = new Map<string, Promise<void>>()
/** What they measured: written back without running ffmpeg again if an undo drops it from the doc. */
const measuredEnds = new Map<string, number>()
/** The pairs being measured now. */
const checkingEnds = shallowReactive(new Set<string>())
/** One comparison at a time, as cut detection (storyCuts). */
let endCheckQueue: Promise<void> = Promise.resolve()

/** Overrides for a keyframe generation (continuity, edits); defaults: the shot's image prompt and cast references. */
export interface KeyframeOptions {
  prompt?: string
  referenceImages?: string[]
  aspectRatio?: string
  label?: string
}

export function createStills(core: StoryCore, runner: StoryRunner, cuts: StoryCuts) {
  const { story, aspect, update, updateShot, fact, modelFor, outputOf, jobState, keyframeOf, endKeyframeOf, continuityContext, shotNumber, shotName, freshShot, cancelIfRendering } =
    core
  const { project, assets, jobs } = core.stores
  const { until, run, settled } = runner
  const { previousEnd } = cuts

  /** The cast's, the scene's and the place's reference images, most important first, as many as the story's image model takes. */
  function refsFor(shot: StoryShot, lead: KeyframeRef[] = []): KeyframeRef[] {
    const max = modelFor('image')?.params.find((p) => p.key === 'referenceImages')?.ui.maxItems ?? 0
    // After the previous shot's last frame, its keyframe adds nothing; the scene's opening keyframe still does.
    const continuity = continuityRefs(continuityContext(), shot, !lead.length)
    return keyframeRefs(story.value, shot, max, { lead, continuity, usable: (id) => assets.get(id)?.status === 'ready' })
  }
  const takesReferences = (model: ModelSpec) => model.params.some((p) => p.key === 'referenceImages')

  /**
   * Moves the shot's current keyframe (or the one still rendering) into its history — a new one takes its place, so a
   * still marked stale by Update scenes isn't any more. Call inside an update.
   */
  function rememberKeyframe(s: StoryShot) {
    delete s.stillStale
    const job = s.keyframeGenerationId ? jobs.byId[s.keyframeGenerationId] : undefined
    const current = s.keyframeAssetId ?? outputOf(s.keyframeGenerationId)?.id ?? (job && !jobs.isTerminal(job) ? job.id : undefined)
    if (current) s.keyframeHistory = [...(s.keyframeHistory ?? []).filter((id) => id !== current), current].slice(-KEYFRAME_HISTORY)
  }

  /** Earlier keyframes, newest first: ready ones and ones still rendering. */
  const keyframeHistoryOf = (shot: StoryShot) =>
    (shot.keyframeHistory ?? [])
      .map((id) => ({ id, asset: assets.get(id) ?? outputOf(id), state: jobState(id) }))
      .filter((h) => h.asset || inFlight(h.state))
      .reverse()

  /**
   * Takes the keyframe off the shot — undoable, and the image stays in Assets (remove it there to delete the file).
   * It doesn't go into the history: removing means it's not wanted; earlier keyframes stay there to pick from.
   */
  function removeKeyframe(shot: StoryShot) {
    cancelIfRendering(shot.keyframeGenerationId)
    updateShot(shot.id, 'Remove still', (s) => {
      s.keyframeGenerationId = undefined
      s.keyframeAssetId = undefined
      delete s.stillStale
    })
  }

  /** Drops an earlier keyframe from the shot's history (undoable; the image stays in Assets). */
  function forgetKeyframe(shot: StoryShot, id: string) {
    cancelIfRendering(id)
    updateShot(shot.id, 'Remove earlier still', (s) => {
      s.keyframeHistory = (s.keyframeHistory ?? []).filter((x) => x !== id)
    })
  }

  /**
   * Uses an existing image from Assets as the shot's keyframe (the current one goes into the history). The video model
   * renders the project's shape, so an image of another shape gets a warning: it will be cropped or letterboxed.
   */
  function setKeyframe(shot: StoryShot, assetId: string) {
    const asset = assets.get(assetId)
    if (asset?.kind !== 'image' || asset.status !== 'ready') return void toast.warning('Pick an image that has finished processing')
    if (assetId === keyframeOf(shot)?.id) return
    updateShot(shot.id, 'Still from Assets', (s) => {
      rememberKeyframe(s)
      s.keyframeHistory = (s.keyframeHistory ?? []).filter((x) => x !== assetId)
      s.keyframeAssetId = assetId
      s.keyframeGenerationId = undefined
    })
    const { width, height } = project.doc.settings
    if (asset.width && asset.height && Math.abs(Math.log(asset.width / asset.height / (width / height))) > Math.log(1.15)) {
      toast.warning(`This image isn’t ${aspect.value}`, { description: 'The video comes out in the project’s shape, so the picture will be cropped. A still of the right shape keeps the framing.' })
    }
  }

  /** Makes an earlier keyframe the shot's keyframe again (the current one goes into the history). */
  function restoreKeyframe(shot: StoryShot, id: string) {
    updateShot(shot.id, 'Use earlier still', (s) => {
      rememberKeyframe(s)
      s.keyframeHistory = (s.keyframeHistory ?? []).filter((x) => x !== id)
      const asset = assets.get(id)
      s.keyframeAssetId = asset?.id
      s.keyframeGenerationId = asset ? undefined : id
    })
  }

  /**
   * The first frame of the shot's Blender previs, once ready: the keyframe is drawn over it — its camera and blocking,
   * each coloured figure named — so the video's look still matches the grey box the camera guide follows.
   */
  function previsRef(shot: StoryShot): KeyframeRef | undefined {
    const id = shot.previs?.firstFrameAssetId
    if (!id || assets.get(id)?.status !== 'ready') return undefined
    const figures = shot.previs!.figures?.map((f) => `the ${f.color} figure is ${f.name}`).join(', ')
    return { id, kind: 'previs', label: `the blocking of shot ${shotName(shot)}`, ...(figures ? { figures } : {}) }
  }

  function planKeyframe(shot: StoryShot, opts: KeyframeOptions = {}): Planned | string {
    const model = modelFor('image')
    if (!model) return 'No image model available — add a fal.ai key or enable demo mode'
    // Without explicit references: the shot's previs first (its camera and blocking), then the cast's and the place's,
    // named in the prompt so the model knows which is which.
    const previs = opts.referenceImages ? undefined : previsRef(shot)
    const refs = opts.referenceImages ? undefined : refsFor(shot, previs ? [previs] : [])
    const params = fitParams(model, {
      prompt: opts.prompt ?? withLegend(imagePrompt(story.value, shot, refs), refs ?? []),
      aspectRatio: opts.aspectRatio ?? aspect.value,
      referenceImages: opts.referenceImages ?? refs!.map((r) => r.id),
    })
    return {
      model,
      params,
      label: opts.label ?? `Still · shot ${shotName(shot)}`,
      keyframeFor: opts.referenceImages ? undefined : shot.id,
      apply: (gid) =>
        updateShot(shot.id, 'Still', (s) => {
          rememberKeyframe(s)
          s.keyframeGenerationId = gid
          s.keyframeAssetId = undefined
        }),
    }
  }

  /**
   * The shot's last moment (StoryShot.endFrame) drawn from its own keyframe — the place, light and people kept, what
   * changed and where the camera ends from the description — for the clip to land on (first/last frame). `draft`: no
   * keyframe needed yet (a batch plans it before the keyframe is done; afterPicture plans it again then).
   */
  function planEndKeyframe(shot: StoryShot, opts: { draft?: boolean } = {}): Planned | string {
    const model = modelFor('image')
    if (!model) return 'No image model available — add a fal.ai key or enable demo mode'
    if (!shot.endFrame?.trim()) return 'Describe the end frame first'
    const start = keyframeOf(shot)
    if (start?.status !== 'ready' && !opts.draft) return 'Make the still first — the end frame is drawn from it'
    const max = model.params.find((p) => p.key === 'referenceImages')?.ui.maxItems ?? 0
    const still = !shot.camera?.trim() || /static|locked|still/i.test(shot.camera)
    const lead: KeyframeRef[] = start?.status === 'ready' ? [{ id: start.id, kind: 'start', label: `the first frame of shot ${shotName(shot)}`, still, shotId: shot.id }] : []
    const refs = keyframeRefs(story.value, shot, max, { continuity: lead, usable: (id) => assets.get(id)?.status === 'ready' })
    const params = fitParams(model, { prompt: withLegend(imagePrompt(story.value, shot, refs, true), refs), aspectRatio: aspect.value, referenceImages: refs.map((r) => r.id) })
    return {
      model,
      params,
      label: `End frame · shot ${shotName(shot)}`,
      name: `Shot ${shotName(shot)} — end frame`,
      apply: (gid) =>
        updateShot(shot.id, 'End frame', (s) => {
          s.endKeyframeGenerationId = gid
          s.endKeyframeAssetId = undefined
        }),
    }
  }

  /** Takes the end frame off the shot (undoable; the image stays in Assets): the clip then ends where it will. */
  function removeEndKeyframe(shot: StoryShot) {
    cancelIfRendering(shot.endKeyframeGenerationId)
    updateShot(shot.id, 'Remove end frame', (s) => {
      s.endKeyframeGenerationId = undefined
      s.endKeyframeAssetId = undefined
    })
  }

  /** An image from Assets as the shot's end frame. */
  function setEndKeyframe(shot: StoryShot, assetId: string) {
    updateShot(shot.id, 'End frame', (s) => {
      s.endKeyframeAssetId = assetId
      s.endKeyframeGenerationId = undefined
    })
  }

  /** The shot's two stills, when both are ready: what the end check compares. */
  function endPair(shot: StoryShot): { startId: string; endId: string } | undefined {
    const start = keyframeOf(shot)
    const end = endKeyframeOf(shot)
    return start?.status === 'ready' && end?.status === 'ready' ? { startId: start.id, endId: end.id } : undefined
  }

  /** "startId endId" while the shot's two stills are ready and not compared yet (endCheckFresh): checkEndFrame has work. */
  function endCheckDue(shot: StoryShot): string | undefined {
    const pair = endPair(shot)
    return pair && !endCheckFresh(shot, pair.startId, pair.endId) ? `${pair.startId} ${pair.endId}` : undefined
  }

  /** The shot's two stills are being compared now. */
  const checkingEnd = (shot: StoryShot) => {
    const key = endCheckDue(shot)
    return Boolean(key && checkingEnds.has(key))
  }

  /**
   * How alike the shot's start and end keyframes are (the server's frame-similarity: local, free), saved on the shot
   * as a fact — found by the app, not an undo step — once per pair of stills. It decides whether the end picture goes
   * with the clip (endState): one barely different froze it, one of another composition cut it in two. A failure
   * leaves it unchecked, and the clip gets only the end's description.
   */
  function checkEndFrame(shot: StoryShot): Promise<void> {
    const key = endCheckDue(shot)
    if (!key) return Promise.resolve()
    const [startId, endId] = key.split(' ') as [string, string]
    const save = (ssim: number) =>
      fact((s) => {
        const x = s.shots.find((y) => y.id === shot.id)
        // Redrawn while it was measured: the number is for pictures it no longer has.
        if (!x || keyframeOf(x)?.id !== startId || endKeyframeOf(x)?.id !== endId) return
        x.endCheck = { startId, endId, ssim }
      })
    const known = measuredEnds.get(key)
    if (known !== undefined) {
      save(known)
      return Promise.resolve()
    }
    const running = endChecks.get(key)
    if (running) return running
    checkingEnds.add(key)
    const run = endCheckQueue.then(async () => {
      try {
        const { ssim } = await api.analysis.frameSimilarity(startId, endId)
        measuredEnds.set(key, ssim)
        save(ssim)
      } catch (err) {
        // Tried again next time it is asked for (a server restarted, an older one without the endpoint).
        endChecks.delete(key)
        console.warn(`[story] end frame check failed for shot ${shotName(shot)}: ${errorMessage(err)}`)
      } finally {
        checkingEnds.delete(key)
      }
    })
    endCheckQueue = run
    endChecks.set(key, run)
    return run
  }

  /** The user's call on the end picture: always sent ('image'), only its description ('text'), or the check's (undefined). Undoable. */
  function setEndUse(shot: StoryShot, use: StoryShot['endUse']) {
    updateShot(shot.id, use === 'image' ? 'Send end frame' : use === 'text' ? 'End frame as text' : 'End frame by the check', (s) => {
      if (use) s.endUse = use
      else delete s.endUse
    })
  }

  /** Splits the shot at its end keyframe: the next shot starts from that picture (see endFrame.splitAtEndFrame). Undoable. */
  function splitAtEnd(shot: StoryShot) {
    update('Split at end frame', (s) => void splitAtEndFrame(s, shot.id, () => nanoid(8)))
  }

  /**
   * A still drawn from another still that the same batch is still making — a shot's end frame from its keyframe, the
   * next shot's keyframe from that end frame: it waits for that picture, then is planned again with it (run() starts
   * it then, see Planned.prepare). Stills of a chain go one after another; their clips can then render in parallel.
   */
  function afterPicture(
    draft: Planned,
    makes: { shotId: string; what: 'keyframe' | 'end' },
    awaited: { shotId: string; what: 'keyframe' | 'end'; name: string },
    replan: () => Planned | string | Promise<Planned | string>,
  ): Planned {
    const note = `waits for ${awaited.name}`
    // The awaited still now: its picture, and the generation drawing it.
    const now = () => {
      const x = freshShot(awaited.shotId)
      if (!x) return undefined
      return awaited.what === 'keyframe' ? { picture: keyframeOf(x), generationId: x.keyframeGenerationId } : { picture: endKeyframeOf(x), generationId: x.endKeyframeGenerationId }
    }
    // A picture there already is the one being made again (Stills again): wait for the new one, not build on the old.
    const old = now()?.picture
    const stale = old?.status === 'ready' ? old.id : undefined
    const fresh = () => {
      const pic = now()?.picture
      return pic?.status === 'ready' && pic.id !== stale ? pic : undefined
    }
    return {
      ...draft,
      waitNote: note,
      makes: { ...makes, waitsFor: awaited.name },
      prepare: async () => {
        // Read as it starts waiting — the batch starts what it waits for just before: a render dead already then is an
        // old one (a keyframe that failed last time), not the one coming.
        const start = now()?.generationId
        const startDead = isDead(jobState(start))
        // Why the picture won't come: waiting on (up to 20 minutes) for a still that failed, was canceled or removed, or
        // a shot that was deleted, held the chain with nothing to say why.
        const gaveUp = (): string | undefined => {
          if (!freshShot(makes.shotId) || !freshShot(awaited.shotId)) return 'the shot was deleted'
          const gid = now()?.generationId
          if (gid === start && startDead) return undefined
          if (!gid) return start ? `${awaited.name} was removed` : undefined
          return isDead(jobState(gid)) ? `${awaited.name} failed or was canceled` : undefined
        }
        await until(() => Boolean(fresh() || gaveUp()))
        const pic = fresh()
        if (!pic) {
          const why = gaveUp()
          return why ? `${draft.label}: not drawn — ${why}` : `${draft.label}: ${note} — it never came`
        }
        await assets.whenReady(pic.id).catch(() => undefined)
        return replan()
      },
    }
  }

  /** The shot's end frame, once its keyframe (being made in the same batch) is there. */
  function planEndKeyframeAfterStart(shot: StoryShot): Planned | string {
    const draft = planEndKeyframe(shot, { draft: true })
    if (typeof draft === 'string') return draft
    return afterPicture(draft, { shotId: shot.id, what: 'end' }, { shotId: shot.id, what: 'keyframe', name: 'its still' }, () => {
      const x = freshShot(shot.id)
      return x ? planEndKeyframe(x) : 'The shot was deleted'
    })
  }

  /**
   * The shot's keyframe, once the end frame of the shot before it (being made in the same batch) is there — compared
   * with its keyframe first: only a visible change goes along as this one's moment (continuityRefs).
   */
  function planKeyframeAfterPreviousEnd(shot: StoryShot, before: StoryShot): Planned | string {
    const draft = planKeyframe(shot)
    if (typeof draft === 'string') return draft
    return afterPicture(draft, { shotId: shot.id, what: 'keyframe' }, { shotId: before.id, what: 'end', name: `shot ${shotName(before)}’s end frame` }, async () => {
      const prev = freshShot(before.id)
      if (prev) await checkEndFrame(prev)
      const x = freshShot(shot.id)
      return x ? planKeyframe(x) : 'The shot was deleted'
    })
  }

  /** Why the story's image model can't build on an existing image, if it can't. */
  function imageEditBlocker(): string | undefined {
    const model = modelFor('image')
    if (!model) return 'No image model available'
    if (!takesReferences(model)) return `${model.label} doesn't take reference images — pick an image model that does (e.g. FLUX.2 klein or Nano Banana)`
    return undefined
  }

  /** The keyframe redone from itself with one change ("remove the car"); the result replaces it, the old one stays in the history. */
  function planKeyframeEdit(shot: StoryShot, instruction: string): Planned | string {
    const blocker = imageEditBlocker()
    if (blocker) return blocker
    const keyframe = keyframeOf(shot)
    if (!keyframe) return 'The shot has no still to edit yet'
    const change = instruction.trim().replace(/[.\s]+$/, '')
    if (!change) return 'Describe the change first'
    // "Auto" keeps the reference's shape, so the edit can't reframe the shot.
    const auto = modelFor('image')!.params.find((p) => p.key === 'aspectRatio')?.ui.options?.some((o) => o.value === 'auto')
    return planKeyframe(shot, {
      prompt: `${change}. Keep everything else exactly as in the reference image.`,
      referenceImages: [keyframe.id],
      aspectRatio: auto ? 'auto' : aspect.value,
      label: `Still edit · shot ${shotName(shot)}`,
    })
  }

  /**
   * New shots of the same moment from the shot's still — a wide, a close-up, the reverse… (coverage.ts): each a copy
   * of the shot (its cast, place, length and video prompt; no lines, which stay with the shot) with the angle's type,
   * its still drawn from this one. Not in the story yet: shotsFromStill puts them in, planShotsFromStill prices them.
   */
  function coverageShots(shot: StoryShot, angles: CoverageAngle[]): StoryShot[] {
    return angles.map((a) => ({
      id: nanoid(8),
      ...(shot.sceneId ? { sceneId: shot.sceneId } : {}),
      ...(shot.scene ? { scene: shot.scene } : {}),
      description: shot.description,
      shotType: a.shotType,
      ...(a.view ? { view: a.view } : {}),
      prompt: shot.prompt,
      duration: shot.duration,
      characterIds: [...shot.characterIds],
      ...(shot.partialIds?.length ? { partialIds: [...shot.partialIds] } : {}),
      ...(shot.hiddenIds?.length ? { hiddenIds: [...shot.hiddenIds] } : {}),
      ...(shot.placeId ? { placeId: shot.placeId } : {}),
      dialogue: [],
      videoGenerationIds: [],
    }))
  }

  /** One new shot's still, drawn from the shot's still from the angle's camera. */
  function planCoverage(shot: StoryShot, draft: StoryShot, angle: CoverageAngle): Planned | string {
    const blocker = imageEditBlocker()
    if (blocker) return blocker
    const still = keyframeOf(shot)
    if (still?.status !== 'ready') return 'Make the still first — the new shots are drawn from it'
    return planKeyframe(draft, {
      prompt: coveragePrompt(angle, shot.description),
      referenceImages: [still.id],
      aspectRatio: aspect.value,
      label: `Still · ${angle.label} · from shot ${shotName(shot)}`,
    })
  }

  /** What shotsFromStill would start, to price it (the shots aren't made). */
  const planShotsFromStill = (shot: StoryShot, angles: CoverageAngle[]) => coverageShots(shot, angles).map((d, i) => planCoverage(shot, d, angles[i]!))

  /** The shots after this one (after its whole multi-shot), then their stills — undoable in one step. */
  async function shotsFromStill(shot: StoryShot, angles: CoverageAngle[]): Promise<number> {
    const drafts = coverageShots(shot, angles)
    const plans = drafts.map((d, i) => planCoverage(shot, d, angles[i]!))
    const problem = plans.find((p): p is string => typeof p === 'string')
    if (problem) {
      toast.warning('Can’t make shots from this still', { description: problem })
      return 0
    }
    update(`${drafts.length} shot${drafts.length === 1 ? '' : 's'} from shot ${shotName(shot)}’s still`, (st) => {
      let after = shot.id
      for (const d of drafts) {
        const copy = structuredClone(d)
        if (shot.sceneId) insertShot(st, shot.sceneId, copy, after)
        else st.shots.splice(st.shots.findIndex((x) => x.id === after) + 1, 0, copy)
        after = copy.id
      }
    })
    return run(plans)
  }

  /**
   * The character's video reference for LTX: redrawn by the story's image model from their pictures, standing on plain
   * light grey in full wardrobe — LTX's subject references copy what is behind and around the person (a skyline, a chair).
   */
  function planVideoRef(characterId: string): Planned | string {
    const blocker = imageEditBlocker()
    if (blocker) return blocker
    const c = story.value.characters.find((x) => x.id === characterId)
    if (!c) return 'This character is gone'
    const model = modelFor('image')!
    const max = model.params.find((p) => p.key === 'referenceImages')?.ui.maxItems ?? 1
    const refs = [...new Set([c.refAssetId, ...(c.refAssetIds ?? [])])].filter((id): id is string => Boolean(id && assets.get(id)?.status === 'ready')).slice(0, Math.max(1, max))
    if (!refs.length) return `Add a picture of ${titleCase(c.name)} first (Front view)`
    const params = fitParams(model, {
      prompt: videoRefPrompt(lookOf(c), refs.length),
      referenceImages: refs,
      aspectRatio: '3:4',
    })
    return {
      model,
      params,
      label: `Video reference · ${titleCase(c.name)}`,
      apply: (gid) =>
        update('Video reference', (s) => {
          const x = s.characters.find((y) => y.id === characterId)
          if (!x) return
          x.videoRefGenerationId = gid
          x.videoRefAssetId = undefined
        }),
    }
  }

  /**
   * Continuity: a keyframe that picks up where the previous shot ends — its last frame as the first reference (with
   * the cast's references after it) and a prompt that tells the model to continue from it.
   */
  async function keyframeFromPrevious(shot: StoryShot): Promise<void> {
    const blocker = imageEditBlocker()
    if (blocker) return void toast.warning('Can’t continue from the previous shot', { description: blocker })
    const end = previousEnd(shot)
    if (!end) return void toast.warning('The previous shot has no video take yet')
    const prev = story.value.shots[shotNumber(shot) - 2]!
    let frame: AssetDTO
    try {
      frame = await api.assets.frame(project.id!, end.asset.id, end.seconds, `Shot ${shotName(prev)} · last frame`)
      assets.upsert(frame)
      // A render can't take an input that is still processing (the server refuses it).
      await assets.whenReady(frame.id)
    } catch (err) {
      return void toast.error('Couldn’t grab the previous shot’s last frame', { description: errorMessage(err) })
    }
    const refs = refsFor(shot, [{ id: frame.id, kind: 'frame', label: 'the previous shot’s last frame', shotId: prev.id }])
    await run([
      planKeyframe(shot, {
        prompt: withLegend(`${CONTINUE_FROM_REFERENCE}. ${imagePrompt(story.value, shot, refs)}`, refs),
        referenceImages: refs.map((r) => r.id),
        label: `Still (continued) · shot ${shotName(shot)}`,
      }),
    ])
  }

  /**
   * A scene that continues the one before (StoryScene.continuesPrevious): its opening keyframe drawn from that scene's
   * last frame, waited for — the scene's other keyframes take their layout from it.
   */
  async function openingFromPrevious(shot: StoryShot): Promise<void> {
    await keyframeFromPrevious(shot)
    const gid = story.value.shots.find((x) => x.id === shot.id)?.keyframeGenerationId
    if (!gid) return
    await settled([gid])
    const out = outputOf(gid)
    if (out) await assets.whenReady(out.id).catch(() => undefined)
  }

  /** A character's video reference: the one set, else the output of the render making it. */
  const videoRefOf = (c: StoryCharacter): string | undefined => c.videoRefAssetId ?? outputOf(c.videoRefGenerationId)?.id

  /** The story with each character's finished video reference filled in (its render may have ended since). */
  function withVideoRefs(s: StoryDoc): StoryDoc {
    if (!s.characters.some((c) => !c.videoRefAssetId && c.videoRefGenerationId)) return s
    return { ...s, characters: s.characters.map((c) => (c.videoRefAssetId || !c.videoRefGenerationId ? c : { ...c, videoRefAssetId: videoRefOf(c) })) }
  }

  return {
    refsFor,
    rememberKeyframe,
    keyframeHistoryOf,
    removeKeyframe,
    forgetKeyframe,
    setKeyframe,
    restoreKeyframe,
    planKeyframe,
    planEndKeyframe,
    removeEndKeyframe,
    setEndKeyframe,
    endCheckDue,
    checkingEnd,
    checkEndFrame,
    setEndUse,
    splitAtEnd,
    planEndKeyframeAfterStart,
    planKeyframeAfterPreviousEnd,
    imageEditBlocker,
    planKeyframeEdit,
    planShotsFromStill,
    shotsFromStill,
    planVideoRef,
    keyframeFromPrevious,
    openingFromPrevious,
    videoRefOf,
    withVideoRefs,
  }
}

export type StoryStills = ReturnType<typeof createStills>
