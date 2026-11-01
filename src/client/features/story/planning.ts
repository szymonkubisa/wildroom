/**
 * The storyboard's video planning, pure: which params a shot or a multi-shot group is rendered with. No Vue, no
 * stores — everything it reads comes in through a PlanContext; useStory adds what a started render changes.
 */
import { KLING_FAL_ELEMENT_VIEWS } from '@shared/models/catalog/fal'
import { klingElementLimit, klingElementRef } from '@shared/models/catalog/kling'
import { fitParams } from '@shared/models/fit'
import { KLING_MAX_SHOT_CHARS, multiShotProblem, parseMultiShot } from '@shared/models/multishot'
import type { ModelSpec, ParamValues } from '@shared/models/types'
import { type IdentitySource, STORYBOARD_MANAGED, type VideoWorkflow, followsRecordedAudio, modelFamily, rendersSeparately, workflowFor } from '@shared/models/workflow'
import { blockingOf, legacySceneKey, lightOf, placeOf, shotLabel } from '@shared/story/structure'
import { countWords } from '@shared/text/speech'
import type { ShotTake, StoryCharacter, StoryDoc, StoryMultishot, StoryPlace, StoryShot } from '@shared/types/story'
import { castToken, isUnseen, shotCast } from './cast'
import { type ClipContext, type CompiledClip, compileClip, compilerFor, cutPoints, endingOf } from './dialects'
import { endState } from './endFrame'
import { type Cut, cameraFor, clipSeconds, cutsForLength, groupOf, planCutsFor, styleFor, styleNegatives } from './multishot'
import { placeViewPhoto, shotBackground } from './references'
import { continuing } from './sceneRun'
import { NO_SUBTITLES, speaksAudio, storyLanguage } from './soundtrack'

/** What planning reads: the story and a few lookups the app answers from its stores. */
export interface PlanContext {
  story: StoryDoc
  /** The project's shape ('16:9', '9:16' or '1:1'). */
  aspect: string
  /** The asset exists and has finished processing. */
  assetReady(id?: string): boolean
  /** The shot's keyframe (picked or generated), if it has one. */
  keyframeOf(shot: StoryShot): { id: string } | undefined
  /** The shot's end keyframe (StoryShot.endFrame drawn), if it has one: the clip lands on it. */
  endKeyframeOf?(shot: StoryShot): { id: string } | undefined
  /** The story's render settings for the model: the draft ones, or the final ones when `final` (see storySettings). */
  settingsFor(model: ModelSpec, final: boolean): ParamValues
  /** The shot's voice track (its ElevenLabs lines in one audio file as long as the clip), when made and still current. */
  voiceTrackOf?(shot: StoryShot): { id: string; seconds: number } | undefined
}

/**
 * Whether `model` makes this shot to its recorded lines (audio to follow) instead of voicing them itself: an LTX model
 * that takes an audio track, the shot not an insert, every spoken line said by someone on screen with an ElevenLabs
 * voice. Such a shot renders on its own from its keyframe — exact words, timing and lip sync, the right voice — which
 * LTX speaking the lines (alone or in a multi-shot clip) doesn't give.
 */
export function followsVoices(story: StoryDoc, shot: StoryShot, model: ModelSpec | undefined): boolean {
  if (!followsRecordedAudio(model, false)) return false
  const spoken = shot.dialogue.filter((l) => l.text.trim())
  if (!spoken.length || /\binsert\b/i.test(shot.shotType ?? '')) return false
  return spoken.every((l) => {
    const c = l.characterId ? story.characters.find((x) => x.id === l.characterId) : undefined
    return Boolean(c?.voiceId && !isUnseen(c) && shot.characterIds.includes(c.id))
  })
}

/**
 * Characters a video model gets as reference images: asset ids, prompt names by the model's cast token ("Image 1",
 * "character1", "@Image1"), voice samples ("Audio 1", LTX only).
 */
export interface VideoSubjects {
  ids: string[]
  tokens: Map<string, string>
  voices: Map<string, string>
  voiceParams: ParamValues
  /** The place as the scene reference (the image after the people): Licon's "Image 3: Scene, …". */
  scene?: { id: string; token: string; name: string; description: string }
}

/** A planned video render: the model, its params and the label it gets in the queue. */
export interface VideoPlan {
  model: ModelSpec
  params: ParamValues
  label: string
}

/** A planned multi-shot render, with where the prompt puts the cuts (recorded on the take, see MultishotTakeCuts). */
export interface MultishotPlan extends VideoPlan {
  planned: number[]
  total: number
}


// Where a shot is and who stands where in what light: its own settings, else its scene's, else its place's.
export { blockingOf, lightOf, placeOf }

export const shotNumber = (story: StoryDoc, shot: StoryShot) => story.shots.findIndex((x) => x.id === shot.id) + 1

export const groupShots = (story: StoryDoc, g: StoryMultishot) =>
  g.shotIds.map((id) => story.shots.find((s) => s.id === id)).filter((s): s is StoryShot => Boolean(s))

/**
 * The story's settings for a video render (resolution, fps, audio…): the draft model's, or the final model's when
 * `final`. Only what the model has, and never what the storyboard sets per shot or group (STORYBOARD_MANAGED: prompt,
 * frames, length, references, multi-shot…), which comes on top.
 */
export function storySettings(story: StoryDoc, model: ModelSpec, final: boolean): ParamValues {
  const chosen = (final ? story.finalVideoSettings : story.videoSettings) ?? {}
  return Object.fromEntries(
    Object.entries(chosen).filter(([key]) => !STORYBOARD_MANAGED.has(key) && model.params.some((p) => p.key === key)),
  ) as ParamValues
}

/** The prompt is within the model's word limit (workflowFor(model).maxWords: LTX's 200), if it has one. */
const withinWords = (workflow: VideoWorkflow, text: string) => !workflow.maxWords || countWords(text) <= workflow.maxWords

/**
 * One shot's video prompt, written in the model's dialect (workflowFor(model).dialect, see dialects/): LTX gets
 * Lightricks' order (framing, look and light, action, how it ends, cast, blocking, camera, sound) with Licon's "Image
 * 1: …" blocks when it has references; Kling, Veo and Happy Horse their own guides' wording. A shot with an end frame
 * says how it ends (endingOf) whether or not the end picture goes along; one made to its voice track (`lipSync`)
 * holds the camera still and gives the lines' words only.
 *
 * A model that generates its own audio also gets the dialogue and sound effects, so it speaks the lines with lip sync
 * instead of ElevenLabs; when that runs past the model's prompt limit the sounds go first, then the dialogue.
 */
export function videoPrompt(
  ctx: PlanContext,
  shot: StoryShot,
  model?: ModelSpec,
  refs?: VideoSubjects,
  /** `guided`: a camera guide (the shot's previs) sets the camera, so the prompt leaves the move out. */
  opts: { fromFrame?: boolean; final?: boolean; lipSync?: boolean; guided?: boolean } = {},
) {
  const workflow = workflowFor(model)
  const place = placeOf(ctx.story, shot)
  const speaks = Boolean(model && speaksAudio(model, ctx.settingsFor(model, Boolean(opts.final))))
  const promptParam = model?.params.find((p) => p.key === 'prompt')
  return compilerFor(workflow.dialect).shot({
    shot,
    characters: ctx.story.characters,
    style: styleFor(ctx.story.style, model, speaks && shot.dialogue.some((l) => l.text.trim())),
    camera: shot.camera && !opts.guided ? cameraFor(shot.camera, model) : undefined,
    context: {
      blocking: blockingOf(ctx.story, shot),
      light: lightOf(ctx.story, shot),
      language: storyLanguage(ctx.story),
      subjects: refs?.tokens.size ? refs.tokens : undefined,
      voices: refs?.voices.size ? refs.voices : undefined,
      scene: refs?.scene,
      place: placeContext(place),
      speech: workflow.speech,
    },
    speaks,
    fromFrame: opts.fromFrame,
    ending: endingOf(shot),
    lipSync: opts.lipSync,
    fits: (text) => (!promptParam || promptParam.schema.safeParse(text).success) && withinWords(workflow, text),
  })
}

/** How the prompt names the n-th cast member: shared now (the Composer's @mentions name them the same way). */
export { castToken }

const placeContext = (place: ReturnType<typeof placeOf>): ClipContext['place'] => place && { name: place.name, description: place.description }

/**
 * The place's photo for a clip made from references: the one of the direction the (first) shot looks in, else the
 * main one — the main plate sent with every shot put the same view behind both sides of a conversation. A view of
 * another direction is described by the place's first clause only: the rest says what the main view shows.
 */
function scenePlate(story: StoryDoc, shot: StoryShot, place: StoryPlace, ready: (id?: string) => boolean): { id: string; description: string } | undefined {
  const view = shotBackground(story, shot)
  const turned = view && view !== 'main' ? placeViewPhoto(place, view, ready) : undefined
  const id = turned ?? place.refAssetIds?.find(ready)
  if (!id) return undefined
  const description = place.description || place.name
  return { id, description: turned ? description.split(/[:;.]/)[0]!.trim() || place.name : description }
}

/**
 * The negative prompt: spoken lines tend to come out as burned-in subtitles, so a render with dialogue rules them out;
 * a model whose negative prompt works also gets what the style says to avoid (styleFor took it out of the prompt).
 */
export function negativePromptFor(style: string, workflow: VideoWorkflow, speaks: boolean): string | undefined {
  const terms = [...(speaks ? NO_SUBTITLES.split(', ') : []), ...(workflow.negative === 'effective' ? styleNegatives(style) : [])]
  return terms.length ? [...new Set(terms)].join(', ') : undefined
}

/**
 * The characters a video model gets as reference images: each one's front view, in the order they appear, as many as
 * the model takes — without a start frame (`cast.max`), or with one when `withKeyframe` (`cast.maxWithKeyframe`; 0 for
 * LTX, whose references stay out of image-to-video). Without them the keyframe is the only picture of a face, and the
 * model draws a new one as soon as the head turns.
 */
export function videoSubjects(ctx: PlanContext, model: ModelSpec, shots: StoryShot[], opts: { withKeyframe?: boolean } = {}): VideoSubjects | undefined {
  const workflow = workflowFor(model)
  // Reference images only (Kling's elements are ids from its library or views of the Cast, see castPlan).
  const cast = workflow.cast?.param === 'referenceImages' ? workflow.cast : undefined
  const max = cast ? (opts.withKeyframe ? cast.maxWithKeyframe : cast.max) : 0
  // Licon's "Audio n" voice blocks are LTX wording: other dialects name no voice samples.
  const voiced = workflow.dialect === 'ltx' || workflow.dialect === 'generic'
  const ready = (id?: string) => ctx.assetReady(id)
  const ids: string[] = []
  const tokens = new Map<string, string>()
  const voices = new Map<string, string>()
  const voiceParams: ParamValues = {}
  // In the Cast's order, not the shots': the same person is the same "Image n" (and "Audio n") in every clip.
  const present = new Set(shots.flatMap(shotCast))
  for (const id of ctx.story.characters.map((c) => c.id).filter((id) => present.has(id))) {
    const c = ctx.story.characters.find((x) => x.id === id)
    // LTX (Licon MSR) copies what a reference shows around the person too: it gets the plain-background video reference.
    const videoRef = workflow.dialect === 'ltx' ? c?.videoRefAssetId : undefined
    const front = c && !isUnseen(c) ? [videoRef, c.refAssetId, ...(c.refAssetIds ?? [])].find(ready) : undefined
    if (!front || ids.length >= max) continue
    ids.push(front)
    tokens.set(c!.id, castToken(workflow, ids.length, c))
    // The model takes the voices of the first two references (Audio 1, Audio 2).
    const voiceKey = `voice${ids.length}`
    if (voiced && ready(c!.voiceSampleAssetId) && model.params.some((p) => p.key === voiceKey)) {
      voices.set(c!.id, `Audio ${ids.length}`)
      voiceParams[voiceKey] = c!.voiceSampleAssetId
    }
  }
  if (!ids.length) return undefined
  // The place's photo of the shot's direction as the scene, when the model takes one (scenePlate): LTX's background,
  // or (Seedance) one more reference picture after the cast, from references only.
  const place = placeOf(ctx.story, shots[0]!)
  const inRefs = workflow.scene?.param === 'referenceImages' && !opts.withKeyframe && ids.length < max
  const plate = (workflow.scene?.param === 'referenceBackground' || inRefs) && place ? scenePlate(ctx.story, shots[0]!, place, ready) : undefined
  const token = inRefs ? (workflow.scene?.token ?? '@Image{n}').replace('{n}', String(ids.length + 1)) : castToken(workflow, ids.length + 1)
  const scene = plate && place ? { id: plate.id, token, name: place.name, description: plate.description } : undefined
  if (scene && inRefs) ids.push(scene.id)
  return { ids, tokens, voices, voiceParams, scene }
}

/** The place's photo as LTX's background param; a model taking it among the references has it in `ids` already. */
const backgroundOf = (model: ModelSpec, subjects: VideoSubjects) =>
  workflowFor(model).scene?.param === 'referenceBackground' ? subjects.scene?.id : undefined

/** The cast (and the place) in the model's own slots: the params that carry them and how the prompt names them. */
export interface CastPlan {
  subjects: VideoSubjects
  params: ParamValues
}

/** A character's pictures, ready ones without repeats: the front view first, then the other angles. */
const viewsOf = (ctx: PlanContext, c: StoryCharacter) =>
  [...new Set([c.refAssetId, ...(c.refAssetIds ?? [])])].filter((id): id is string => ctx.assetReady(id))

/**
 * Kling elements on fal (`cast.param` 'elementImages'), made from the Cast: each character, in order of appearance, as
 * a front view plus up to 3 more angles, as many as the model takes with or without a start frame — flattened into
 * `elementImages` + `elementCounts` and named by the profile's token (@Element1…). A character with only a front view
 * can't be an element (Kling wants 2–4 views): without a start frame, on a model that also takes reference images
 * (O3), it goes in as one after the place's photo (@Image1, @Image2…); otherwise the prompt names it in words. With a
 * start frame only true elements go in (the frame already shows the place and the faces).
 */
export function elementCast(ctx: PlanContext, model: ModelSpec, shots: StoryShot[], withKeyframe: boolean): CastPlan | undefined {
  const workflow = workflowFor(model)
  const cast = workflow.cast
  if (cast?.param !== 'elementImages' || !shots.length) return undefined
  const maxElements = withKeyframe ? cast.maxWithKeyframe : cast.max
  const maxImages = model.params.find((p) => p.key === 'elementImages')?.ui.maxItems ?? Infinity
  const minViews = cast.needsAngles ? 2 : 1
  const images: string[] = []
  const counts: number[] = []
  const tokens = new Map<string, string>()
  const frontOnly: { c: StoryCharacter; front: string }[] = []
  for (const id of new Set(shots.flatMap(shotCast))) {
    const c = ctx.story.characters.find((x) => x.id === id)
    if (!c || isUnseen(c)) continue
    const views = viewsOf(ctx, c).slice(0, KLING_FAL_ELEMENT_VIEWS.max)
    if (!views.length) continue
    if (views.length >= minViews && counts.length < maxElements && images.length + views.length <= maxImages) {
      images.push(...views)
      counts.push(views.length)
      tokens.set(c.id, castToken(workflow, counts.length, c))
    } else frontOnly.push({ c, front: views[0]! })
  }
  // The reference-image slot next to the elements (O3): the place's photo first, then the front-only characters,
  // within its inputs in all (elements + images ≤ 7).
  const refs: string[] = []
  let scene: VideoSubjects['scene']
  const slot = workflow.scene?.param === 'referenceImages' && !withKeyframe ? model.params.find((p) => p.key === 'referenceImages') : undefined
  if (slot && (counts.length || frontOnly.length)) {
    const room = Math.max(0, (slot.ui.maxItems ?? 0) - counts.length)
    const refToken = (n: number) => (workflow.scene?.token ?? '@Image{n}').replace('{n}', String(n))
    const place = placeOf(ctx.story, shots[0]!)
    const plate = place && scenePlate(ctx.story, shots[0]!, place, (id) => ctx.assetReady(id))
    if (plate && place && refs.length < room) {
      refs.push(plate.id)
      scene = { id: plate.id, token: refToken(refs.length), name: place.name, description: plate.description }
    }
    for (const { c, front } of frontOnly) {
      if (refs.length >= room) break
      refs.push(front)
      tokens.set(c.id, refToken(refs.length))
    }
  }
  if (!tokens.size) return undefined
  return {
    subjects: { ids: [], tokens, voices: new Map(), voiceParams: {}, scene },
    params: { elementImages: images, elementCounts: counts, referenceImages: refs },
  }
}

/** Kling elements as the prompt's subjects: each character by the profile's token, in the order the ids are sent. */
function elementSubjects(model: ModelSpec, cast: StoryCharacter[]): VideoSubjects | undefined {
  if (!cast.length) return undefined
  const workflow = workflowFor(model)
  const tokenOf = (i: number) => (workflow.cast?.param === 'elements' ? castToken(workflow, i + 1, cast[i]) : `@${klingElementRef(i)}`)
  return { ids: [], tokens: new Map(cast.map((c, i) => [c.id, tokenOf(i)])), voices: new Map(), voiceParams: {} }
}

/** Characters synced to Kling's element library (Kling's own API), in order of appearance, as many as the model takes. */
function klingLibraryCast(ctx: PlanContext, model: ModelSpec, shots: StoryShot[], withKeyframe: boolean): CastPlan | undefined {
  if (model.provider !== 'kling' || workflowFor(model).cast?.param !== 'elements') return undefined
  const cast = [...new Set(shots.flatMap(shotCast))]
    .map((id) => ctx.story.characters.find((c) => c.id === id))
    .filter((c): c is StoryCharacter => Boolean(c?.kling?.elementId) && !isUnseen(c!))
    .slice(0, klingElementLimit(model.id, withKeyframe))
  const subjects = elementSubjects(model, cast)
  return subjects && { subjects, params: { elements: cast.map((c) => c.kling!.elementId) } }
}

/**
 * The cast as `model` takes it, with a start frame (`withKeyframe`) or without: reference images (and the place as the
 * scene, the voices — videoSubjects), Kling elements made from the Cast's views (fal, elementCast) or synced to
 * Kling's element library (Kling's own API). Undefined when no character can go in.
 */
export function castPlan(ctx: PlanContext, model: ModelSpec, shots: StoryShot[], withKeyframe: boolean): CastPlan | undefined {
  switch (workflowFor(model).cast?.param) {
    case 'referenceImages': {
      const subjects = videoSubjects(ctx, model, shots, { withKeyframe })
      return subjects && { subjects, params: { ...subjects.voiceParams, referenceImages: subjects.ids, referenceBackground: backgroundOf(model, subjects) } }
    }
    case 'elementImages':
      return elementCast(ctx, model, shots, withKeyframe)
    case 'elements':
      return klingLibraryCast(ctx, model, shots, withKeyframe)
    default:
      return undefined
  }
}

/**
 * Whether a group can be made from `source` with `model`: the model offers it (workflowFor(model).sources) and the
 * story has what it needs — the cast's pictures for 'references', the first shot's keyframe for 'keyframe', both
 * (and at least one character the model takes with a start frame) for 'both'.
 */
export function canUseSource(ctx: PlanContext, g: StoryMultishot, model: ModelSpec | undefined, source: IdentitySource): boolean {
  const shots = groupShots(ctx.story, g)
  const keyframe = Boolean(shots[0] && ctx.keyframeOf(shots[0]))
  if (!model) return source === 'keyframe' && keyframe
  if (!workflowFor(model).sources.includes(source)) return false
  if (source === 'keyframe') return keyframe
  return (source === 'references' || keyframe) && Boolean(castPlan(ctx, model, shots, source === 'both'))
}

/**
 * How a group's clip is made with `model`: from the cast's (and the place's) references with no keyframe (Licon MSR
 * on LTX, Veo's ingredients, Kling O3's elements), from the first shot's keyframe with the cast as elements ('both',
 * Kling), or from the keyframe alone with the cuts written out. The group's choice when the model offers it and the
 * story has what it needs, else the first the model offers that works (its profile's order), else — nothing usable
 * yet — the first the story can still get (a keyframe can always be made; references only when the cast has pictures).
 */
export function groupSource(ctx: PlanContext, g: StoryMultishot, model: ModelSpec | undefined): IdentitySource {
  const usable = (source: IdentitySource) => canUseSource(ctx, g, model, source)
  if (g.source && usable(g.source)) return g.source
  // Automatic: what uses the approved keyframe first — the still is checked before paying for video, and a clip made
  // from references used none of the scene's keyframes (user's call, 13.10). References stay a choice: tested 7.10 on
  // shots 4–5, from the first keyframe LTX drifted after the cut where references held faces and sides.
  // Before shot 1 has its keyframe too — Stills makes it; picking references meanwhile meant Stills skipped it, so the
  // group never got one and rendered from references for good.
  const sources: IdentitySource[] = model ? workflowFor(model).sources : ['keyframe']
  const keyed = sources.filter((x) => x !== 'references')
  const fromKeyframe = keyed.find(usable) ?? keyed.find((x) => (x === 'keyframe' ? true : Boolean(model && canCast(ctx, g, model, true))))
  if (fromKeyframe) return fromKeyframe
  const now = sources.find(usable)
  if (now) return now
  // Nothing to make it from yet: the first source the story can still get, in the profile's order — a keyframe
  // (Prepare makes them for every group not made from references), the cast with it ('both') when the model takes the
  // cast's pictures with a start frame, references only when the cast has pictures. Never references the cast has none
  // of: Prepare would skip the keyframes and a group on Kling or Veo could never render.
  const reachable = (source: IdentitySource) =>
    source === 'keyframe' ? true : source === 'both' ? Boolean(model && canCast(ctx, g, model, true)) : castHasPictures(ctx, g, model)
  // A model that takes no start frame and no pictures of the cast yet: keyframes would go unused.
  return sources.find(reachable) ?? (sources.includes('both') ? 'keyframe' : 'references')
}

/**
 * Whether a group renders shot by shot, each shot from its own keyframe ("Separate shots"), or as one clip ("One
 * clip"). One clip once the user picked what it is made from (its source), and always with a model that takes no
 * start frame. On LTX shot by shot otherwise (rendersSeparately): every native multi-shot take failed while single
 * shots from their keyframes were the best — older one-clip takes stay, and a shot's own take wins over them when the
 * film is assembled. Any other model renders a group on Auto as one clip until its later shots have keyframes of their
 * own: one clip takes only the first shot's keyframe (LTX blends toward a picture placed at a cut, it doesn't cut to
 * it), and the others would go unused — but not once it has a take as one clip.
 */
export function rendersShotByShot(ctx: PlanContext, g: StoryMultishot, model: ModelSpec | undefined): boolean {
  if (g.source) return false
  if (model && !model.params.some((p) => p.key === 'firstFrame')) return false
  if (rendersSeparately(model, true)) return true
  if (g.videoGenerationIds.length) return false
  const shots = groupShots(ctx.story, g)
  // A shot with a set end renders on its own too: one clip ends once.
  return shots.slice(1).some((shot) => Boolean(ctx.keyframeOf(shot))) || shots.some((shot) => Boolean(ctx.endKeyframeOf?.(shot)))
}

/** What stillsWanted reads besides the story: how each multi-shot group renders with its model now. */
export interface StillsContext {
  story: StoryDoc
  /** The group renders shot by shot, each shot from its own keyframe (rendersShotByShot). */
  shotByShot(g: StoryMultishot): boolean
  /** What the group's one clip is made from (groupSource). */
  sourceOf(g: StoryMultishot): IdentitySource
}

/**
 * The stills a shot needs — one rule for what Stills draws and what the scene's progress counts (they decided apart and
 * drifted: a scene stuck at "stills 3/4", a still drawn but never counted). Its keyframe when a render starts from it:
 * a shot of its own, every shot of a group rendered shot by shot, the first of a group made as one clip from a keyframe
 * — and a later close or medium shot of someone in a group on Auto, which then renders shot by shot (from the first
 * keyframe, a far wide, LTX invented Kael's face in the close-up after the cut). Also the scene's opening shot whenever
 * another shot of the scene needs one: the layout every later keyframe follows — made even when its own group renders
 * from references (without it the first close-up became the layout). A continuing shot starts from the take before it:
 * none. Its end frame is drawn from its keyframe, so only with one.
 */
export function stillsWanted(ctx: StillsContext, shot: StoryShot): { keyframe: boolean; end: boolean } {
  const keyframe = keyframeUsed(ctx, shot) || opensSceneFor(ctx, shot)
  return { keyframe, end: keyframe && Boolean(shot.endFrame?.trim()) }
}

/** A render of the shot starts from its keyframe (see stillsWanted). */
function keyframeUsed(ctx: StillsContext, shot: StoryShot): boolean {
  if (continuing(ctx.story, shot)) return false
  const group = groupOf(ctx.story, shot.id)
  if (!group || ctx.shotByShot(group)) return true
  const at = group.shotIds.indexOf(shot.id)
  if (!group.source && at > 0 && shot.characterIds.length && /close|medium/i.test(shot.shotType ?? '')) return true
  return at === 0 && ctx.sourceOf(group) !== 'references'
}

/** The shot opens its scene and another shot of the scene starts from a keyframe: its keyframe is their layout. */
function opensSceneFor(ctx: StillsContext, shot: StoryShot): boolean {
  const sceneOf = (x: StoryShot) => x.sceneId ?? legacySceneKey(x)
  const scene = sceneOf(shot)
  if (!scene) return false
  const inScene = ctx.story.shots.filter((x) => sceneOf(x) === scene)
  return inScene[0]?.id === shot.id && inScene.some((x) => x.id !== shot.id && keyframeUsed(ctx, x))
}

/** The model takes the group's cast (with a start frame when `withKeyframe`): at least one character goes in. */
const canCast = (ctx: PlanContext, g: StoryMultishot, model: ModelSpec, withKeyframe: boolean) => Boolean(castPlan(ctx, model, groupShots(ctx.story, g), withKeyframe))

/** The model takes cast pictures and at least one character seen in the group has a ready one. */
function castHasPictures(ctx: PlanContext, g: StoryMultishot, model: ModelSpec | undefined): boolean {
  if (!workflowFor(model).cast) return false
  return [...new Set(groupShots(ctx.story, g).flatMap(shotCast))].some((id) => {
    const c = ctx.story.characters.find((x) => x.id === id)
    return Boolean(c && !isUnseen(c) && viewsOf(ctx, c).length)
  })
}

/**
 * How long a group's clip is with `model` and where its cuts fall: the shots scaled to a length the model renders
 * (planCutsFor), or laid over the one fixed length some models render from the cast alone (Veo's ingredients: 8 s).
 */
export function groupCutPlan(ctx: PlanContext, g: StoryMultishot, model: ModelSpec | undefined, shots = groupShots(ctx.story, g)): { total: number; cuts: Cut[] } {
  const source = groupSource(ctx, g, model)
  const fixed = model && source === 'references' && castPlan(ctx, model, shots, false) ? workflowFor(model).cast?.fixedSeconds : undefined
  return fixed ? { total: fixed, cuts: cutsForLength(shots, fixed) } : planCutsFor(model, shots)
}

/** Why a group is too big for `model` (more shots, or longer, than one clip of it takes), if it is. */
export function groupLimitProblem(story: StoryDoc, g: StoryMultishot, model: ModelSpec | undefined): string | undefined {
  if (!model) return undefined
  const { maxShots, maxSeconds } = workflowFor(model).multishot
  const shots = groupShots(story, g)
  if (shots.length > maxShots) return `${model.label} takes up to ${maxShots} shots per clip — this group has ${shots.length}`
  const seconds = shots.reduce((a, s) => a + Math.max(1, s.duration), 0)
  if (seconds > maxSeconds) return `${model.label} renders up to ${maxSeconds} s per clip — these shots run ${Math.round(seconds * 10) / 10} s and get shortened`
  return undefined
}

/** The params with the subjects' references when the model accepts them with the rest, else without them. */
export function fitWithSubjects(model: ModelSpec, values: ParamValues, withRefs: ParamValues | undefined): ParamValues {
  if (withRefs) {
    const params = fitParams(model, withRefs)
    if (!model.validate?.(params)) return params
  }
  return fitParams(model, values)
}

/** A shot rendered with `model`; `final` takes the story's final settings (draft → final). */
export function planVideo(ctx: PlanContext, shot: StoryShot, model: ModelSpec, opts: { final?: boolean; continueFrom?: string } = {}): VideoPlan {
  // A continuing shot on a model that continues clips (LTX on the GPU): it picks up the previous take's ending — its
  // motion, look and framing — instead of starting from a keyframe.
  const continueFrom = opts.continueFrom && model.params.some((p) => p.key === 'continueFrom') ? opts.continueFrom : undefined
  const keyframe = continueFrom ? undefined : ctx.keyframeOf(shot)
  const fromFrame = Boolean(keyframe || continueFrom)
  const workflow = workflowFor(model)
  // From a keyframe: image-to-video, one continuous take, no reference images (Licon: MSR isn't for image-to-video).
  // Without one: the characters' and the place's references (reference-to-video).
  const subjects = fromFrame ? undefined : videoSubjects(ctx, model, [shot])
  // Characters synced to Kling's element library keep their look: pass the ids and name them by the profile's token
  // (@element_1…) in the shot text — never inside a spoken line.
  const cast = shot.characterIds
    .map((id) => ctx.story.characters.find((c) => c.id === id))
    .filter((c) => c?.kling?.elementId)
    .slice(0, model.provider === 'kling' ? klingElementLimit(model.id, Boolean(keyframe)) : 0)
  const elements = cast.map((c) => c!.kling!.elementId)
  const final = Boolean(opts.final)
  // A dialogue shot made to its recorded lines (audio to follow): the track is the clip's sound and sets its length —
  // and its prompt holds the camera still and gives the words only (videoPrompt's lipSync).
  const track = keyframe && followsVoices(ctx.story, shot, model) ? ctx.voiceTrackOf?.(shot) : undefined
  // A Blender previs on a model that follows a camera guide: the grey box with a keyframe (its look), else the depth
  // render when there is one. The guide sets the camera and the length; the prompt leaves the move out.
  // The grey box needs the keyframe for its look (alone it renders grey); without one, only a depth render guides.
  // A model without a guide type (Seedance on OpenRouter) takes the grey box as a reference video, the keyframe as its
  // look: only with a keyframe, never a depth render.
  const previs = !continueFrom && shot.previs && model.params.some((p) => p.key === 'guideVideo') ? shot.previs : undefined
  const guideKinds = model.params.some((p) => p.key === 'guideKind')
  // A render removed from the project (or still processing) isn't sent: the shot is planned without it.
  const guide = previs && keyframe && ctx.assetReady(previs.assetId)
    ? { guideVideo: previs.assetId, guideKind: 'layout' }
    : previs?.depthAssetId && guideKinds && ctx.assetReady(previs.depthAssetId)
      ? { guideVideo: previs.depthAssetId, guideKind: 'depth' }
      : undefined
  // The guide's length is the clip's, so the estimate prices what renders; a voice track still caps it.
  const guided = guide && previs?.frames ? previs.frames / (previs.fps ?? 24) : undefined
  const seconds = guided !== undefined ? Math.min(guided, track?.seconds ?? guided) : (track?.seconds ?? shot.duration)
  const prompt = videoPrompt(ctx, shot, model, elementSubjects(model, cast as StoryCharacter[]), { fromFrame, final, lipSync: Boolean(track), guided: Boolean(guide) })
  // Spoken lines tend to come out as burned-in subtitles; where the negative prompt has an effect, rule that out.
  const speaks = speaksAudio(model, ctx.settingsFor(model, final)) && shot.dialogue.some((l) => l.text.trim())
  const negativePrompt = negativePromptFor(ctx.story.style, workflow, speaks)
  // A shot with a set end (a reveal, a transformation): rendered between its two frames, where the model takes both —
  // only when the end is the same camera with a visible change, or the user says so (endState): LTX lands on the end
  // picture whatever it is, and one barely different froze the clip, one recomposed cut it in two. Never on a shot made
  // to its voice track: it holds still on its lines (videoPrompt's lipSync). The ending is in the prompt either way.
  // A model that can't follow a camera guide and land on an end frame together keeps the guide.
  const endWithGuide = !guide || !model.validate?.({ firstFrame: 'start', lastFrame: 'end', guideVideo: 'guide' })
  const end = keyframe && !track && endWithGuide && model.params.some((p) => p.key === 'lastFrame') ? ctx.endKeyframeOf?.(shot) : undefined
  const endKeyframe = end && endState(shot, keyframe!.id, end.id) === 'image' ? end : undefined
  const values = {
    ...ctx.settingsFor(model, final),
    prompt,
    firstFrame: keyframe?.id,
    ...(endKeyframe ? { lastFrame: endKeyframe.id } : {}),
    ...(continueFrom ? { continueFrom } : {}),
    duration: clipSeconds(model, seconds),
    aspectRatio: ctx.aspect,
    elements,
    negativePrompt,
    ...(track ? { audioClip: track.id } : {}),
    ...(guide ?? {}),
  }
  const withRefs = subjects && {
    ...values,
    ...subjects.voiceParams,
    prompt: videoPrompt(ctx, shot, model, subjects, { final }),
    referenceImages: subjects.ids,
    referenceBackground: backgroundOf(model, subjects),
    // From references some models render one fixed length (Veo's ingredients: 8 s).
    ...(workflow.cast?.fixedSeconds ? { duration: workflow.cast.fixedSeconds } : {}),
  }
  // Kling elements on fal: the Cast's views, with the keyframe (up to 3) or without it.
  const views = elementCast(ctx, model, [shot], Boolean(keyframe))
  const withViews = views && {
    ...values,
    ...views.params,
    prompt: videoPrompt(ctx, shot, model, views.subjects, { fromFrame: Boolean(keyframe), final }),
  }
  const params = fitWithSubjects(model, values, withRefs ?? withViews)
  return { model, params, label: `${final ? 'Final' : continueFrom ? 'Video (continued)' : 'Video'} · shot ${shotLabel(ctx.story, shot)}` }
}

/**
 * Whether the group goes to Kling's own API as its native shot list ("Shot n (Xs): …" lines with `multiShot` on):
 * a Kling model there with a multi-shot switch.
 */
export function usesKlingShotList(model: ModelSpec, workflow = workflowFor(model)): boolean {
  return workflow.dialect === 'kling' && workflow.multishot.method === 'native' && model.provider === 'kling' && model.params.some((p) => p.key === 'multiShot')
}

/**
 * Room kept free in each shot of a Kling shot list: the 512-character limit is checked after Kling expands the element
 * mentions (@Element1…) — a 505-character shot with two of them was refused (fal, 9.10).
 */
const SHOT_LIST_MARGIN = 64

/** Whether the group goes in as Kling's shot list on fal (`multiPrompt` → `multi_prompt`, sent instead of the prompt). */
export function usesKlingMultiPrompt(model: ModelSpec, workflow = workflowFor(model)): boolean {
  return workflow.dialect === 'kling' && workflow.multishot.method === 'native' && model.params.some((p) => p.key === 'multiPrompt')
}

/** The shot list parses back (parseMultiShot, as the Kling adapter reads it) to exactly these shots, and Kling takes it. */
function parsesAsShotList(clip: CompiledClip, total: number): boolean {
  const parsed = parseMultiShot(clip.prompt)
  return Boolean(
    clip.shots &&
      parsed &&
      parsed.shots.length === clip.shots.length &&
      parsed.shots.every((s, i) => s.seconds === clip.shots![i]!.duration) &&
      !multiShotProblem(parsed.shots, total),
  )
}

/** The compiled shots make a shot list the model takes: one per cut, whole seconds ≥ 1 adding up to the clip, each within the limit. */
function isShotList(clip: CompiledClip, cuts: number, total: number, maxShots: number, limit: number): boolean {
  const shots = clip.shots
  return Boolean(
    shots &&
      shots.length === cuts &&
      shots.length <= maxShots &&
      shots.every((s) => Number.isInteger(s.duration) && s.duration >= 1 && s.prompt.trim() && s.prompt.length <= limit) &&
      shots.reduce((a, s) => a + s.duration, 0) === total,
  )
}

/**
 * One clip for a whole multi-shot group with `model`: the cuts written in the model's dialect (LTX prose, Kling shot
 * lines, Veo timestamps, Happy Horse beats), made from what groupSource picks — the cast's (and the place's)
 * references, the first shot's keyframe with the cast as elements, or the keyframe alone; `final` takes the story's
 * final settings. Kling's own API gets its native shot list with `multiShot` on; Kling on fal its `multiPrompt`.
 */
export function planMultishot(ctx: PlanContext, g: StoryMultishot, model: ModelSpec, opts: { final?: boolean } = {}): MultishotPlan | string {
  const final = Boolean(opts.final)
  const shots = groupShots(ctx.story, g).map((x) => (x.camera ? { ...x, camera: cameraFor(x.camera, model) } : x))
  if (shots.length < 2) return 'A multi-shot needs at least two shots'
  const workflow = workflowFor(model)
  const source = groupSource(ctx, g, model)
  const cast = source === 'keyframe' ? undefined : castPlan(ctx, model, shots, source === 'both')
  // From the cast alone some models render one fixed length (Veo's ingredients: 8 s): the cuts are laid over it.
  const { total, cuts } = groupCutPlan(ctx, g, model, shots)
  const compiler = compilerFor(workflow.dialect)
  const promptParam = model.params.find((p) => p.key === 'prompt')
  const speaks = speaksAudio(model, ctx.settingsFor(model, final)) && shots.some((s) => s.dialogue.some((l) => l.text.trim()))
  const style = styleFor(ctx.story.style, model, speaks)
  const nativeList = usesKlingShotList(model, workflow)
  const multiPrompt = !nativeList && usesKlingMultiPrompt(model, workflow)
  const shotLimit = nativeList || multiPrompt ? (workflow.multishot.maxShotChars ?? KLING_MAX_SHOT_CHARS) - SHOT_LIST_MARGIN : undefined
  const context: ClipContext = {
    blocking: blockingOf(ctx.story, shots[0]!),
    light: lightOf(ctx.story, shots[0]!),
    language: storyLanguage(ctx.story),
    styleAsIs: true,
    place: placeContext(placeOf(ctx.story, shots[0]!)),
    speech: workflow.speech,
  }
  const fits = (clip: CompiledClip) =>
    (!promptParam || promptParam.schema.safeParse(clip.prompt).success) &&
    withinWords(workflow, clip.prompt) &&
    (!shotLimit || !clip.shots || clip.shots.every((s) => s.prompt.length <= shotLimit))
  /** The clip, and the shot-list params that go with it (Kling's multiShot switch, fal's multiPrompt). */
  const compile = (extra: ClipContext = {}): { clip: CompiledClip; native: ParamValues } => {
    const input = { cuts, total, characters: ctx.story.characters, style, context: { ...context, ...extra } }
    if (nativeList || multiPrompt) {
      // Kling's shot list (the scene setup inside shot 1), unless it doesn't come out as one: then one prompt.
      const list = compileClip(compiler, { ...input, context: { ...input.context, shotList: true, shotLimit } }, fits)
      if (nativeList && parsesAsShotList(list, total)) return { clip: list, native: { multiShot: true } }
      if (multiPrompt && isShotList(list, cuts.length, total, workflow.multishot.maxShots, shotLimit!))
        return { clip: list, native: { multiPrompt: list.shots!.map((s) => ({ prompt: s.prompt, duration: s.duration })) } }
    }
    return { clip: compileClip(compiler, input, fits), native: nativeList ? { multiShot: false } : multiPrompt ? { multiPrompt: undefined } : {} }
  }
  const keyframe = ctx.keyframeOf(cuts[0]!.shot)?.id
  // From the keyframe the picture shows who stands where: a shot is placed only by its own blocking (multishotPrompt).
  const plain = compile({ fromFrame: Boolean(keyframe) })
  // From the first shot's keyframe as the start frame, the cuts written out (the prompting guide allows cutting away
  // from a first frame when the prompt says so). Keyframes at the cuts used to go in as in-between guides, but LTX's
  // guides interpolate — the picture morphs towards them instead of cutting.
  const values = {
    ...ctx.settingsFor(model, final),
    prompt: plain.clip.prompt,
    firstFrame: keyframe,
    duration: total,
    aspectRatio: ctx.aspect,
    negativePrompt: negativePromptFor(ctx.story.style, workflow, speaks),
    ...plain.native,
  }
  // With the cast: on LTX Licon's MSR scene — the people and the place as references, no start frame (MSR is
  // reference-to-video, not image-to-video), the prompt in their template; on Kling the elements, with the start frame
  // when the source is 'both'.
  const withCast =
    cast &&
    (() => {
      const scene = cast.subjects.scene
      const clip = compile({
        subjects: cast.subjects.tokens,
        voices: cast.subjects.voices,
        scene: scene && { token: scene.token, name: scene.name, description: scene.description },
        fromFrame: source === 'both' && Boolean(keyframe),
      })
      return { ...values, firstFrame: source === 'both' ? keyframe : undefined, ...cast.params, prompt: clip.clip.prompt, ...clip.native }
    })()
  const params = fitWithSubjects(model, values, withCast)
  const label = `${final ? 'Final multi-shot' : 'Multi-shot'} · shots ${shotLabel(ctx.story, shots[0]!)}–${shotLabel(ctx.story, shots.at(-1)!)}`
  // Recorded now: later edits of the shot lengths must not move where this take was told to cut. Dialects that time
  // their shots in whole seconds (Kling's shot lines, Veo's timestamps) cut where they said.
  const timed = plain.clip.shots
  const planned = timed ? cutPoints(timed.map((s) => s.duration)) : cuts.slice(1).map((c) => c.start)
  return { model, params, label, planned, total }
}

// ------------------------------------------------------------------------------------ models per shot and group

/**
 * The model id a shot's takes are rendered with ("Render with…"): its group's choice for a shot in a multi-shot group
 * (the group renders it), else its own. Undefined = the story's video model.
 */
export function chosenModelId(story: StoryDoc, shot: StoryShot): string | undefined {
  const group = groupOf(story, shot.id)
  return group ? group.modelId : shot.modelId
}

/**
 * What a planned render is made from, read off its params (what really goes, after fitting): a start frame, the
 * cast's pictures, both, or neither (text only).
 */
export function sourceOfParams(params: ParamValues): IdentitySource | undefined {
  const cast = ['referenceImages', 'elementImages', 'elements'].some((key) => Array.isArray(params[key]) && (params[key] as unknown[]).length > 0)
  if (params.firstFrame) return cast ? 'both' : 'keyframe'
  return cast ? 'references' : undefined
}

/** Every take recorded with its model (group takes' cut records that have one, shot takes), by generation id. */
export function takeRecords(story: StoryDoc): Map<string, ShotTake> {
  const out = new Map<string, ShotTake>()
  for (const g of story.multishots ?? []) {
    for (const [id, rec] of Object.entries(g.takes ?? {})) if (rec.modelId) out.set(id, { modelId: rec.modelId, ...(rec.source ? { source: rec.source } : {}) })
  }
  for (const shot of story.shots) for (const [id, rec] of Object.entries(shot.takes ?? {})) if (rec.modelId) out.set(id, rec)
  return out
}

/**
 * Whether a take is a final render: recorded in finalTakeIds when it was started. A take with a take record is final
 * only so — a group rendered with the final model as its "Render with…" choice makes drafts with it. Older takes,
 * from before take records, are judged by their model as before (`legacy`): made with the final model, when that
 * isn't the draft model.
 */
export function isFinalTake(
  story: StoryDoc,
  generationId: string | undefined,
  legacy: { modelId?: string; draftModelId?: string } = {},
  records: ReadonlyMap<string, ShotTake> = takeRecords(story),
): boolean {
  if (!generationId) return false
  if (story.finalTakeIds?.includes(generationId)) return true
  if (records.has(generationId)) return false
  const { modelId, draftModelId } = legacy
  return Boolean(modelId && story.finalVideoModelId && modelId === story.finalVideoModelId && modelId !== draftModelId)
}

/** Two models of one family (LTX on RunPod and local LTX, Kling direct and Kling on fal), or the same model. */
export function sameFamily(a: ModelSpec, b: ModelSpec): boolean {
  if (a.id === b.id) return true
  const family = modelFamily(a)
  return family !== undefined && family === modelFamily(b)
}

/**
 * The model a take's final render uses: the story's final model when it is of the take's family (LTX drafts → a
 * bigger LTX), else the take's own model with the final settings — a Kling take redone by Veo would be another take,
 * not a better one. The final model when the take's model isn't known (or can't be used).
 */
export function finalModelFor(takeModel: ModelSpec | undefined, finalModel: ModelSpec): ModelSpec {
  return !takeModel || sameFamily(takeModel, finalModel) ? finalModel : takeModel
}
