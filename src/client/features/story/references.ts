import { endCheckFresh, endVerdict } from '@shared/story/endFrame'
import { blockingOf, legacySceneKey, lightOf, placeOf, shotLabel } from '@shared/story/structure'
import type { PlaceView, StoryCharacter, StoryDoc, StoryPlace, StoryShot } from '@shared/types/story'
import { PARTIAL_PHRASE, clothesOf, isUnseen, lookOf, partialKind, shotCast, titleCase } from './cast'
import { sentences } from './multishot'
import { type KeyframeRef, referenceLegend, withLegend } from '@shared/story/legend'

export type { KeyframeRef }

/**
 * Which way a place photo looks: the first is the main view; the others by their note — "the reverse view", "the view
 * to the left", as the look designer writes them. A photo of a detail looks no particular way.
 */
export function placeViewOf(place: StoryPlace, assetId: string): PlaceView | undefined {
  if (place.refAssetIds?.[0] === assetId) return 'main'
  const note = place.refNotes?.[assetId]?.toLowerCase() ?? ''
  if (/\breverse\b|opposite way|looking back/.test(note)) return 'reverse'
  if (/\bleft\b/.test(note)) return 'left'
  if (/\bright\b/.test(note)) return 'right'
  return undefined
}

/** How the app names a place's views. */
export const PLACE_VIEW_LABEL: Record<PlaceView, string> = { main: 'Main view', reverse: 'Reverse view', left: 'View to the left', right: 'View to the right' }
/** …and under a thumbnail. */
export const PLACE_VIEW_SHORT: Record<PlaceView, string> = { main: 'Main', reverse: 'Reverse', left: 'Left', right: 'Right' }

const BEARINGS: Record<string, number> = { north: 0, northeast: 45, east: 90, southeast: 135, south: 180, southwest: 225, west: 270, northwest: 315 }

/** The compass direction a camera position or a place's look says it faces ("…on the southern bank looking north…"). */
export function facingOf(text: string | undefined): number | undefined {
  const m = /\b(?:looking|facing|faces|pointing|turned)\s+(?:(?:back|out|due)\s+)?(?:(?:to|toward|towards)\s+the\s+)?((?:north|south)[\s-]?(?:east|west)|north|south|east|west)\b/i.exec(text ?? '')
  return m ? BEARINGS[m[1]!.toLowerCase().replace(/[\s-]/g, '')] : undefined
}

/**
 * Which of its place's views a shot looks toward: what it says, else what its camera position says against the way
 * the place's main view looks — "looking northwest" at a place whose main view looks north is its left view. Shots
 * written before shots had a background still get the view behind them (By the Lake, scene 1). Unknown: undefined.
 */
export function shotBackground(story: Pick<StoryDoc, 'places' | 'shots'>, shot: StoryShot): PlaceView | undefined {
  if (shot.background) return shot.background
  const place = shot.placeId ? story.places?.find((p) => p.id === shot.placeId) : undefined
  const camera = facingOf(shot.view)
  if (!place || camera === undefined) return undefined
  // The place's look says which way its main view looks; else the scene's establishing shot does.
  const opener = shot.sceneId ? story.shots.find((x) => x.sceneId === shot.sceneId) : undefined
  const main = facingOf(place.description) ?? (opener && opener !== shot ? facingOf(opener.view) : undefined)
  if (main === undefined) return undefined
  const turn = ((camera - main + 540) % 360) - 180
  if (Math.abs(turn) <= 30) return 'main'
  if (Math.abs(turn) >= 135) return 'reverse'
  return turn < 0 ? 'left' : 'right'
}

/** The place's photo of a direction, if it has one. */
export const placeViewPhoto = (place: StoryPlace, view: PlaceView, usable: (assetId: string) => boolean = () => true) =>
  (place.refAssetIds ?? []).find((id) => usable(id) && placeViewOf(place, id) === view)

const STOP = new Set(['the', 'and', 'with', 'from', 'view', 'its', 'for', 'one', 'two'])
const words = (text: string) => [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].filter((w) => !STOP.has(w))

/**
 * The place's photos, the ones whose note the shot talks about first ("…taps a card on the WKD ticket machine" →
 * the ticket machine photo), the rest in their own order; `mentioned` is how many of the note's own words the shot
 * uses. Only words no other note of the place has count — "blue", "WKD" or "platform" in two notes says nothing about
 * which photo the shot means. A word counts when a word of the shot starts with it ("machine" → "machines", but
 * "red" not → "covered").
 */
function rankPlaceViews(views: string[], notes: Record<string, string> | undefined, shot: StoryShot): { id: string; mentioned: number }[] {
  const said = words(`${shot.prompt} ${shot.description}`)
  const noteWords = new Map(views.map((id) => [id, words(notes?.[id] ?? '')]))
  const own = (id: string) => {
    const all = noteWords.get(id) ?? []
    const distinct = all.filter((w) => ![...noteWords].some(([other, ws]) => other !== id && ws.includes(w)))
    return distinct.length ? distinct : all
  }
  const score = (id: string) => own(id).filter((w) => said.some((s) => s.startsWith(w))).length
  return views
    .map((id, i) => ({ id, i, mentioned: score(id) }))
    .sort((a, b) => b.mentioned - a.mentioned || a.i - b.i)
    .map(({ id, mentioned }) => ({ id, mentioned }))
}

/** Place photos that still go along once the scene has a keyframe: the ones the shot talks about, at most this many. */
const DETAIL_PHOTOS = 2

/**
 * A shot's keyframe references, most important first and at most `max` (image models take 1–16). `lead` (the
 * previous shot's last frame) goes first.
 *
 * Before the scene has a keyframe: one view of every character, the place's photo that fits the shot best, the
 * characters' other views (a second view each before anyone's third), the place's other photos.
 *
 * Once it has one (`continuity`: the scene's opening keyframe, maybe an earlier one): those first — they are the
 * layout — then the characters, and of the place's photos only the ones the shot talks about (the ticket machine for a
 * close-up of it). Real photos of the place disagree with a generated scene on where things stand, and outnumbering
 * the scene they win: the station building moves across the tracks between shots.
 */
export function keyframeRefs(
  story: StoryDoc,
  shot: StoryShot,
  max: number,
  opts: { lead?: KeyframeRef[]; continuity?: KeyframeRef[]; usable?: (assetId: string) => boolean } = {},
): KeyframeRef[] {
  const usable = opts.usable ?? (() => true)
  // Those seen from behind too: their hair and clothes have to match.
  const cast = shotCast(shot)
    .map((id) => story.characters.find((c) => c.id === id))
    .filter((c) => c !== undefined)
    .map((c) => ({
      id: c.id,
      name: titleCase(c.name),
      views: [c.refAssetId, ...(c.refAssetIds ?? [])].filter((id): id is string => Boolean(id) && usable(id!)),
    }))
  const place = shot.placeId ? story.places?.find((p) => p.id === shot.placeId) : undefined
  const ranked = place ? rankPlaceViews((place.refAssetIds ?? []).filter(usable), place.refNotes, shot) : []
  const continuity = opts.continuity ?? []
  // A keyframe of this camera's layout: the scene's earlier ones, or the shot's own first frame for its end frame. The
  // previous shot's last moment is from another camera — with only that, the place's photo of this direction still
  // goes (The Chase: drawn from the end frame alone, keyframe after keyframe copied its framing).
  // A previs frame is this camera's layout too: the place's photos then only add detail.
  const layout = continuity.some((r) => r.kind === 'continuity' || r.kind === 'start') || (opts.lead ?? []).some((r) => r.kind === 'previs')
  // A shot that says which way it looks gets the photo of that direction, and no photo of another direction: one view
  // of the place sent with every shot put the same lake behind both sides of a conversation (By the Lake, 1.2–1.5).
  const view = shotBackground(story, shot)
  const behind = place && view ? placeViewPhoto(place, view, usable) : undefined
  const otherDirection = (id: string) => Boolean(view && place && placeViewOf(place, id))
  const details = ranked.filter((v) => v.mentioned > 0 && !otherDirection(v.id))
  const placeViews = (layout ? details.slice(0, DETAIL_PHOTOS) : behind ? [{ id: behind }, ...details.filter((v) => v.id !== behind)] : ranked).map((v) => v.id)
  const placeRef = (id: string, i: number): KeyframeRef => {
    // The legend lists images with "; " between them, so a note's own semicolons become commas.
    const note = place?.refNotes?.[id]?.trim().replace(/\s*;\s*/g, ', ')
    const label = `the location “${place!.name}”`
    if (id === behind && !layout) return { id, kind: 'place', label: `${label} as it lies behind them from this camera${note ? ` (${note})` : ''}`, behind: true }
    return { id, kind: 'place', label: note ? `${label}: ${note}` : i ? `${label}, another view` : label }
  }

  // The previous shot's end frame comes after the cast: as image 1 its composition was copied — four shots of a
  // sequence from the same camera, only higher each time (Kael, 5–7). It gives the moment, not the view.
  const ordered: KeyframeRef[] = [...(opts.lead ?? []), ...continuity.filter((r) => r.kind !== 'previousEnd')]
  for (const c of cast) if (c.views[0]) ordered.push({ id: c.views[0], kind: 'character', label: c.name, characterId: c.id })
  ordered.push(...continuity.filter((r) => r.kind === 'previousEnd'))
  if (placeViews[0]) ordered.push(placeRef(placeViews[0], 0))
  const deepest = Math.max(0, ...cast.map((c) => c.views.length))
  for (let i = 1; i < deepest; i++) {
    for (const c of cast) if (c.views[i]) ordered.push({ id: c.views[i]!, kind: 'character', label: `${c.name}, another view`, characterId: c.id })
  }
  placeViews.slice(1).forEach((id, i) => ordered.push(placeRef(id, i + 1)))

  const seen = new Set<string>()
  return ordered.filter((r) => !seen.has(r.id) && seen.add(r.id)).slice(0, Math.max(0, max))
}

/** How the keyframe points at someone seen only in part, by how the shot shows them (partialKind). */
function partialLook(c: StoryCharacter, kind: ReturnType<typeof partialKind>, image: number): string {
  const name = titleCase(c.name)
  if (kind === 'hands') return `Only ${name}’s hands and sleeves are in the frame — the same skin and sleeves as image ${image}`
  if (kind === 'feet') return `Only ${name}’s feet and shoes are in the frame — the same shoes and trousers as image ${image}`
  return `${name}, seen from behind, looks exactly like image ${image}: the same hair, build and clothes`
}

/**
 * Who is in the picture and who isn't, when someone of the scene could leak in — its cast, or anyone in the stills of
 * the story going along (an earlier keyframe, the previous shot's last moment): people from the continuity image
 * walked into The Chase's inserts. "Only Claire is in this picture; Daniel is not." / "Nobody is in this picture."
 */
function castLine(story: StoryDoc, shot: StoryShot, refs: readonly KeyframeRef[]): string | undefined {
  const named = (ids: Iterable<string>) =>
    [...new Set(ids)]
      .map((id) => story.characters.find((c) => c.id === id))
      .filter((c): c is StoryCharacter => Boolean(c) && !isUnseen(c!))
      .map((c) => titleCase(c.name))
  const inShot = (x: StoryShot) => [...shotCast(x), ...(x.hiddenIds ?? [])]
  const here = inShot(shot)
  const scene = shot.sceneId ? story.scenes?.find((x) => x.id === shot.sceneId) : undefined
  const shown = refs.flatMap((r) => story.shots.filter((x) => x.id === r.shotId && x.id !== shot.id))
  const away = named([...(scene?.castIds ?? []), ...shown.flatMap(inShot)].filter((id) => !here.includes(id)))
  if (!away.length) return undefined
  const present = named(here)
  if (!present.length) return 'Nobody is in this picture'
  return `Only ${listed(present)} ${present.length > 1 ? 'are' : 'is'} in this picture; ${listed(away)} ${away.length > 1 ? 'are' : 'is'} not`
}

/**
 * The cast's and the place's looks for the keyframe prompt (`end`: the end frame's). A character whose reference image
 * goes with the request is pointed at it instead of described: a description written before the reference was
 * (re)made — "brown corduroy jacket" when the reference wears an olive overshirt — wins over the picture. Without a
 * reference the description stays. Likewise the place: once the scene has a keyframe, that is the place, not the
 * description. Someone hidden in the dark is only their outline: given their face, the hidden man of The Chase came out
 * lit.
 */
export function looksText(story: StoryDoc, shot: StoryShot, refs: readonly KeyframeRef[], end = false): string {
  const kind = partialKind(shot)
  const cast = shotCast(shot)
    .map((id) => story.characters.find((c) => c.id === id))
    .filter((c): c is StoryCharacter => c !== undefined && !isUnseen(c))
    .map((c) => {
      const partial = !shot.characterIds.includes(c.id)
      const at = refs.findIndex((r) => r.characterId === c.id)
      if (at >= 0) return partial ? partialLook(c, kind, at + 1) : `${titleCase(c.name)} looks exactly like image ${at + 1}: the same face, hairstyle, clothes and accessories`
      return partial ? `${lookOf(c)} — ${PARTIAL_PHRASE[kind]}` : lookOf(c)
    })
  const hidden = (shot.hiddenIds ?? [])
    .map((id) => story.characters.find((c) => c.id === id))
    .filter((c): c is StoryCharacter => c !== undefined && !isUnseen(c))
    .map((c) => {
      const clothes = clothesOf(c)
      return `${titleCase(c.name)} is only a dark outline in the shadow, face unreadable${clothes ? ` (${clothes})` : ''}`
    })
  const place = shot.placeId ? story.places?.find((p) => p.id === shot.placeId) : undefined
  const scene = refs.findIndex((r) => r.kind === 'continuity')
  const behind = refs.findIndex((r) => r.kind === 'place' && r.behind)
  // The same shot later (its end frame): the place as it is now — what has changed in it stays changed.
  const start = refs.findIndex((r) => r.kind === 'start')
  // The previous shot's last moment is from another camera: the layout, this direction's photo or the words say the
  // place better (its legend says what to take from it).
  const previousEnd = refs.findIndex((r) => r.kind === 'previousEnd')
  // The place's description is written from its establishing camera ("reeds screen left, to the west"): a photo of
  // this shot's direction says it better.
  const where =
    start >= 0
      ? `The place is the one in image ${start + 1}, as it is at this moment`
      : scene >= 0
        ? `The place looks exactly like image ${scene + 1}`
        : behind >= 0
          ? `Behind them, from this camera, the place looks exactly like image ${behind + 1}`
          : place?.description
            ? `Location, ${place.name}: ${place.description}`
            : previousEnd >= 0 && `The place is the one in image ${previousEnd + 1}, as it is at this moment`
  // The shot's own positions when its people regroup; else the scene's or the place's, the same in every shot there —
  // unless the shot has its first frame written out: those are seen from the establishing camera ("both facing the
  // lake"), and in a reverse they turned everyone's back to the camera. An end frame has only its own: where things
  // stood at the start is what it changes (the phone left on the floor and in her hand at once).
  const positions = end || shot.frame?.trim() ? shot.blocking?.trim() : blockingOf(story, shot)
  const blocking = positions && `Positions: ${positions}`
  const lit = lightOf(story, shot)
  const light = lit && `Light: ${lit}`
  return [...cast, ...hidden, castLine(story, shot, refs), where, blocking, light].filter(Boolean).join('. ')
}

const listed = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}` : (xs[0] ?? ''))

/** The legend of a still's references: shared code now. */
export { referenceLegend, withLegend }

/**
 * A keyframe is one moment, while the shot's prompt runs through several ("Jan climbs out… walks over… stops"): told
 * nothing, the image model draws them all at once — the same man by the car and in front of Hanka. And nobody looks
 * into the lens, as the keyframes of The Last Road and Impossible Worlds did.
 */
const ONE_MOMENT = 'One still frame: the moment the shot begins, each person in it seen once; nobody looks into the camera'

/** …and for an end frame, the moment the shot ends. */
const LAST_MOMENT = 'One still frame: the moment the shot ends, each person in it seen once'

/** Opening words of a continuity keyframe: the reference is the previous shot's last frame. */
export const CONTINUE_FROM_REFERENCE =
  'Continue directly from the first reference image, a moment later: the same place, light, wardrobe and people, in the same positions'

/**
 * The keyframe prompt (`end`: the end frame's); `refs` are the references going with it (a referenced character is
 * pointed at, not described).
 */
export function imagePrompt(story: StoryDoc, shot: StoryShot, refs: readonly KeyframeRef[] = [], end = false): string {
  // The shot's last moment: its own description says where the camera ends, so the start's camera position goes.
  if (end) return `${sentences([shot.shotType?.trim() && `${shot.shotType.trim()} shot`, LAST_MOMENT, shot.endFrame, looksText(story, shot, refs, true), story.style])}.`
  // A later shot of a scene with no framing of its own had nothing to move the camera: it came back as the opening wide.
  const opening = refs.findIndex((r) => r.kind === 'continuity')
  const framing = shot.shotType?.trim()
    ? `${shot.shotType.trim()} shot`
    : opening >= 0
      ? `A closer shot than image ${opening + 1}, framed on the people and what they do`
      : undefined
  // Where the camera stands: without it the closer shots of a scene came back from the opening wide's camera, everyone
  // with their back to it (The Lake's Invitation, 1.2–1.4: "over-the-shoulder" said nothing of whose shoulder).
  const view = shot.view?.trim() && `Camera: ${shot.view.trim()}`
  // The first moment as one picture; the prompt's beats ("listens, then turns to Kuba") are the clip's.
  const moment = shot.frame?.trim() || shot.prompt
  return `${sentences([framing, view, ONE_MOMENT, moment, looksText(story, shot, refs), story.style])}.`
}

/** How a character's video reference is drawn from their pictures (see StoryCharacter.videoRefAssetId). */
const VIDEO_REF_PROMPT =
  'The same person as in the reference image — the same face, hair, skin and outfit — standing alone, full figure from head to knees, facing the camera, arms relaxed at the sides, neutral expression, on a plain seamless light-grey studio background, soft even studio light, no props, no scenery, photorealistic.'

/** The prompt for a character's video reference: their look, then the studio picture drawn from `pictures` of them. */
export function videoRefPrompt(look: string | undefined, pictures: number): string {
  return [look && `${look}.`, pictures > 1 ? VIDEO_REF_PROMPT.replace('reference image', 'reference images') : VIDEO_REF_PROMPT].filter(Boolean).join(' ')
}

/** Shots of one scene share a layout (in stories from before scenes: the same place, else the same scene heading). */
export const sceneKey = (shot: StoryShot) => shot.sceneId ?? legacySceneKey(shot)

/**
 * …and the same direction: a keyframe takes its background and layout from earlier ones looking the same way. Told
 * to keep the opening wide's place, the reverse shots of a conversation kept its lake behind both people and moved
 * them in front of it (By the Lake, 1.2–1.5).
 */
export function layoutKey(story: Pick<StoryDoc, 'places' | 'shots'>, shot: StoryShot): string | undefined {
  const key = sceneKey(shot)
  return key && `${key}\n${shotBackground(story, shot) ?? 'main'}`
}

/** What continuityRefs reads besides the story: the stills as the app has them. */
export interface ContinuityContext {
  story: StoryDoc
  /** The shot's keyframe (picked or generated), if it has one. */
  keyframeOf(shot: StoryShot): { id: string; status: string } | undefined
  /** The shot's end keyframe (StoryShot.endFrame drawn), if it has one. */
  endKeyframeOf(shot: StoryShot): { id: string; status: string } | undefined
  /** The references a keyframe render was made with (its job's params.referenceImages), while its job is known. */
  madeFrom(generationId: string): unknown
}

/**
 * Earlier keyframes of the shot's scene, for its layout: the opening one (usually the wide shot) — the scene's one
 * source of truth for where things stand — and the nearest earlier one, but only if it was itself made from the
 * opening keyframe: an older keyframe, made before it, may have the set rearranged and would pass that on. Then the
 * previous shot's last moment when it ends on a set picture (previousEnd).
 */
export function continuityRefs(ctx: ContinuityContext, shot: StoryShot, withPrevious = true): KeyframeRef[] {
  const { story } = ctx
  const key = layoutKey(story, shot)
  if (!key) return []
  const at = story.shots.findIndex((x) => x.id === shot.id)
  const layout = layoutRefs(ctx, shot, key, at, withPrevious)
  // Drawn after the previous shot's last frame (its take), that is the moment: the end picture adds nothing.
  const end = withPrevious ? previousEndRef(ctx, shot, at) : undefined
  return end ? [...layout, end] : layout
}

function layoutRefs(ctx: ContinuityContext, shot: StoryShot, key: string, at: number, withPrevious: boolean): KeyframeRef[] {
  const { story, keyframeOf } = ctx
  const madeFrom = (x: StoryShot | undefined) => (x?.keyframeGenerationId ? ctx.madeFrom(x.keyframeGenerationId) : undefined)
  // Looking away from the main view, a keyframe drawn without that direction's photo (before the place had it) has
  // the main view behind it: it would pass that on.
  const facing = shotBackground(story, shot)
  const place = placeOf(story, shot)
  const backdrop = facing && facing !== 'main' && place ? placeViewPhoto(place, facing) : undefined
  const drawnFacing = (x: StoryShot) => {
    const made = madeFrom(x)
    return !backdrop || !Array.isArray(made) || made.includes(backdrop) || made.some((id) => typeof id === 'string' && keyframeIds.has(id))
  }
  const keyframeIds = new Set<string>()
  const earlier = story.shots.slice(0, Math.max(0, at)).filter((x) => {
    if (layoutKey(story, x) !== key || keyframeOf(x)?.status !== 'ready' || !drawnFacing(x)) return false
    keyframeIds.add(keyframeOf(x)!.id)
    return true
  })
  // Only a shot that shows the layout: a close-up adds nothing to where things stand, and its face pulls the next
  // picture toward it (the closing wide from behind came out with Jan turned to the camera, as in shot 10's close-up).
  const layoutShot = (x: StoryShot) => !/close-?up|over-the-shoulder|insert/i.test(x.shotType ?? '')
  // The scene's first wide, else its first shot: a scene that picks up on a close-up has its wide second.
  const first = earlier.find(layoutShot) ?? earlier[0]
  if (!first) return []
  const opening = keyframeOf(first)!.id
  const opener = story.shots.find((x) => sceneKey(x) === sceneKey(shot))
  const what = first === opener ? 'the opening shot of this scene' : layoutShot(first) ? 'the wide shot of this scene' : 'an earlier shot of this scene, looking the same way'
  const out: KeyframeRef[] = [{ id: opening, kind: 'continuity', label: `shot ${shotLabel(story, first)}, ${what}`, shotId: first.id }]
  const previous = withPrevious ? earlier.filter(layoutShot).at(-1) : undefined
  const previousFrom = madeFrom(previous)
  if (previous && previous !== first && Array.isArray(previousFrom) && previousFrom.includes(opening)) {
    out.push({ id: keyframeOf(previous)!.id, kind: 'continuity', label: `shot ${shotLabel(story, previous)}, an earlier shot of this scene`, shotId: previous.id })
  }
  return out
}

/**
 * The shot before ends on a set picture (a reveal, a transformation): this one opens on that moment — the scene as it
 * is now, not as its opening wide showed it (the rings half out of the salt, not the empty plain). Beside the layout,
 * never instead of it, and one hop from a clean keyframe at most: each drawn from the one before alone, The Chase's
 * keyframes piled up artefacts (the car like glass shards by shot 6) and copied the framing. Not when its end barely
 * differs from its start or is another composition (endVerdict): that says nothing of the moment, or the wrong thing.
 * Not measured yet, it goes.
 */
function previousEndRef(ctx: ContinuityContext, shot: StoryShot, at: number): KeyframeRef | undefined {
  const { story } = ctx
  const before = story.shots[at - 1]
  if (!before || sceneKey(before) !== sceneKey(shot) || !before.endFrame?.trim()) return undefined
  const end = ctx.endKeyframeOf(before)
  if (end?.status !== 'ready') return undefined
  const verdict = endCheckFresh(before, ctx.keyframeOf(before)?.id, end.id) ? endVerdict(before.endCheck!.ssim) : undefined
  if (verdict && verdict !== 'changed') return undefined
  // Its own keyframe drawn on the end frame of the shot before it: this would be the second hop.
  const twoBack = story.shots[at - 2]
  const twoBackEnd = twoBack && sceneKey(twoBack) === sceneKey(shot) ? ctx.endKeyframeOf(twoBack)?.id : undefined
  const made = before.keyframeGenerationId ? ctx.madeFrom(before.keyframeGenerationId) : undefined
  if (twoBackEnd && Array.isArray(made) && made.includes(twoBackEnd)) return undefined
  return { id: end.id, kind: 'previousEnd', label: `the last moment of shot ${shotLabel(story, before)}`, shotId: before.id }
}

/**
 * How a batch of keyframes is staged: in a scene that has no keyframe yet, the first shot of the batch opens it and
 * the scene's other batch shots wait for it (they then get it as their layout reference). Shots of a scene that
 * already has a keyframe, or of no scene, start at once.
 */
export function keyframeStages(
  shots: readonly StoryShot[],
  batch: ReadonlySet<string>,
  sceneOf: (shot: StoryShot) => string | undefined,
  hasEarlierKeyframe: (shot: StoryShot) => boolean,
): { opening: string[]; waiting: string[] } {
  const opened = new Map<string, string>()
  const waiting: string[] = []
  for (const shot of shots) {
    const key = batch.has(shot.id) ? sceneOf(shot) : undefined
    if (!key) continue
    // Once a batch shot opens the scene, it is the layout for the scene's later shots — also for those after a
    // keyframe made before it (a close-up made without the wide).
    if (opened.has(key)) waiting.push(shot.id)
    else if (!hasEarlierKeyframe(shot)) opened.set(key, shot.id)
  }
  return { opening: [...opened.values()], waiting }
}
