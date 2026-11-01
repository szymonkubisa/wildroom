import { shotsOfScene } from '@shared/story/structure'
import { PLACE_VIEWS, type PlaceView, type StoryDoc, type StoryPlace, type StoryShot } from '@shared/types/story'
import { type EndState, endState, endStateText } from './endFrame'
import { PLACE_VIEW_LABEL, placeViewPhoto, shotBackground } from './references'

/**
 * Is a scene's place ready for its keyframes, and is a shot ready to animate — pure, for the scene's inspector and
 * board and the folded shot rows: one short state each instead of more lines on the panel.
 */

export interface PlaceReadiness {
  /** The scene's place, if it has one (none: nothing to make ready). */
  place?: StoryPlace
  /**
   * 'ok': its main photo is there (or the scene has no place). 'none': no photo and nothing drawn. 'unapproved':
   * pictures drawn in the look designer, none approved — The Chase's garage, whose keyframes never got a photo of it.
   * 'removed': its photo was removed from Assets.
   */
  state: 'ok' | 'none' | 'unapproved' | 'removed'
  /** Its main photo, while it is there. */
  main?: string
  /** Its other three directions, each with its photo when it has one (none before it has a photo at all). */
  views: { view: PlaceView; photo?: string }[]
  /** The directions it has no photo of… */
  missing: PlaceView[]
  /** …that the scene's shots look toward: their keyframes would get the main view behind the people. */
  needed: PlaceView[]
  /** Pictures of it drawn in the look designer. */
  drawn: number
}

/**
 * How ready the scene's place is (`known`: the photo is still in Assets — one removed there keeps its id on the
 * place; `drawn`: a look designer take that came out). Every shot invents a place that has no approved photo.
 */
export function placeReadiness(
  story: Pick<StoryDoc, 'scenes' | 'places' | 'shots'>,
  sceneId: string,
  known: (assetId: string) => boolean,
  drawn: (generationId: string) => boolean = () => true,
): PlaceReadiness {
  const scene = story.scenes?.find((x) => x.id === sceneId)
  const place = scene?.placeId ? story.places?.find((p) => p.id === scene.placeId) : undefined
  if (!place) return { state: 'ok', views: [], missing: [], needed: [], drawn: 0 }
  const present = (id?: string) => (id && known(id) ? id : undefined)
  const main = present(place.refAssetIds?.[0])
  const views = place.refAssetIds?.length
    ? PLACE_VIEWS.filter((v) => v !== 'main').map((view) => ({ view, photo: present(placeViewPhoto(place, view)) }))
    : []
  const missing = views.filter((v) => !v.photo).map((v) => v.view)
  const wanted = new Set(shotsOfScene(story, sceneId).map((x) => shotBackground(story, x)))
  const takes = (place.designTakes ?? []).filter((t) => drawn(t.generationId)).length
  const state = main ? 'ok' : place.refAssetIds?.length ? 'removed' : takes ? 'unapproved' : 'none'
  return { place, state, ...(main ? { main } : {}), views, missing, needed: missing.filter((v) => wanted.has(v)), drawn: takes }
}

/** What isn't ready about the place, in one line for the Stills dialog and the board's place pin; nothing when it is. */
export function placeNote(r: PlaceReadiness): string | undefined {
  const name = r.place?.name
  if (!name) return undefined
  if (r.state === 'unapproved') return `${r.drawn} picture${r.drawn === 1 ? '' : 's'} of ${name} drawn, none approved — no photo of the place goes with the stills until one is (Cast & Places).`
  if (r.state === 'removed') return `${name}’s photo was removed from Assets — the stills will invent the place until it has one again.`
  if (r.state === 'none') return `${name} has no photo yet — the stills will invent the place.`
  return undefined
}

/** What a shot's status reads besides the shot (the stills, the voice track, the dialogue check): see shotStatus. */
export interface ShotStatusContext {
  /** How its multi-shot group renders it (groupShotByShot), when it is in one. */
  group?: 'separate' | 'one-clip'
  /** Its keyframe and end keyframe, when they are ready. */
  startId?: string
  endId?: string
  /** Made to its voice track (lip sync): the end picture never goes. */
  lipSync?: boolean
  /** Its spoken lines against the room for them (dialogueFitOf). */
  dialogue?: { tight: boolean; spoken: number; available: number }
}

export interface ShotStatus {
  /** In a multi-shot group: rendered as a shot of its own, or as part of the group's one clip. */
  mode?: 'separate' | 'one-clip'
  /** What becomes of its end keyframe (endState), when it has an end frame — and the line that says so. */
  end?: EndState
  endText?: string
  /** What to look at before animating it, one line each. */
  warnings: string[]
}

const fmt = (n: number) => String(Math.round(n * 10) / 10)

/** A shot at a glance, for its folded row: one mark on its end frame, one count of what is wrong. */
export function shotStatus(story: Pick<StoryDoc, 'places' | 'shots'>, shot: StoryShot, ctx: ShotStatusContext): ShotStatus {
  const state = endState(shot, ctx.startId, ctx.endId)
  const end = state && ctx.lipSync ? 'text' : state
  const ssim = shot.endCheck?.ssim
  const warnings: string[] = []
  if (ctx.dialogue?.tight) warnings.push(`≈${Math.round(ctx.dialogue.spoken)} s of dialogue in a ${fmt(ctx.dialogue.available)} s shot`)
  // The direction it looks in has no photo of its place: the keyframe gets the main view behind the people.
  const view = shotBackground(story, shot)
  const place = shot.placeId ? story.places?.find((p) => p.id === shot.placeId) : undefined
  if (view && place && !placeViewPhoto(place, view)) warnings.push(`${place.name} has no photo of its ${PLACE_VIEW_LABEL[view].toLowerCase()}: the still gets the main view behind them`)
  return {
    ...(ctx.group ? { mode: ctx.group } : {}),
    ...(end ? { end, endText: endStateText(end, ssim, { lipSync: Boolean(state && ctx.lipSync), userCall: Boolean(ctx.endId && shot.endUse) }) } : {}),
    warnings,
  }
}
