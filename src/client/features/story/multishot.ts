import type { ModelSpec } from '@shared/models/types'
import { clipAtLeast, clipSeconds, maxClipSeconds, workflowFor } from '@shared/models/workflow'
import { validGroups } from '@shared/story/structure'
import type { StoryCharacter, StoryDoc, StoryShot } from '@shared/types/story'
import { cameraOf, cameraPhrase, cameraSentence } from '../generate/camera'
import { audioBlock, castLooks, isUnseen, lookOf, oppositeSide, screenSides, type ScreenSide, shotCast, subjectsPreamble, titleCase, withSubjects } from './cast'
import { soundtrackPrompt } from './soundtrack'

/**
 * Storyboard multi-shot groups: 2–4 consecutive shots rendered as one clip, following Lightricks' LTX-2.5 guidance —
 * multi-shot is purely prompt phrasing; name the cuts in paragraph order, carry the action across each cut, restate
 * every subject verbatim instead of using pronouns, and keep to 2–4 cuts. Models with a shot list of their own take
 * more (Kling: 6): the group's limit is its model's `workflowFor(model).multishot.maxShots`.
 */

export const MULTISHOT_MIN_SHOTS = 2
/** LTX's limit (three shots of about three seconds in its 10 s clip), and the default wherever no model is known. */
export const MULTISHOT_MAX_SHOTS = 3

// Groups whose shots all still exist, follow one another in story order and share a scene (edits can break that).
export { validGroups }

export const groupOf = (story: StoryDoc, shotId: string) => validGroups(story).find((g) => g.shotIds.includes(shotId))

/**
 * Multi-shot groups from per-shot group numbers (the Director's): each run of consecutive shots with the same number
 * above 0, cut into as-even-as-possible clips of 2–`maxShots` shots; a lone shot stays on its own. Returns shot indexes.
 */
export function breakdownGroups(numbers: readonly number[], maxShots = MULTISHOT_MAX_SHOTS): number[][] {
  const most = Math.max(MULTISHOT_MIN_SHOTS, maxShots)
  const out: number[][] = []
  for (let i = 0; i < numbers.length; ) {
    let j = i
    while (j + 1 < numbers.length && numbers[i]! > 0 && numbers[j + 1] === numbers[i]) j++
    const run = Array.from({ length: j - i + 1 }, (_, k) => i + k)
    if (run.length >= MULTISHOT_MIN_SHOTS) {
      const clips = Math.ceil(run.length / most)
      const base = Math.floor(run.length / clips)
      let extra = run.length % clips
      for (let start = 0; start < run.length; ) {
        const size = base + (extra-- > 0 ? 1 : 0)
        // A shot left over (a model of two shots per clip) stays on its own.
        if (size >= MULTISHOT_MIN_SHOTS) out.push(run.slice(start, start + size))
        start += size
      }
    }
    i = j + 1
  }
  return out
}

/**
 * Whether `shotId` can take in the shot after it: there is one, it is free, and the group stays within `maxShots`
 * (its model's limit, workflowFor(model).multishot.maxShots).
 */
export function canJoinNext(story: StoryDoc, shotId: string, maxShots = MULTISHOT_MAX_SHOTS): boolean {
  const i = story.shots.findIndex((s) => s.id === shotId)
  const next = story.shots[i + 1]
  // A clip is one scene: the next scene starts with a cut of its own.
  if (i < 0 || !next || next.sceneId !== story.shots[i]!.sceneId || groupOf(story, next.id)) return false
  const group = groupOf(story, shotId)
  return !group || (group.shotIds.at(-1) === shotId && group.shotIds.length < Math.max(MULTISHOT_MIN_SHOTS, maxShots))
}

/** Joins `shotId` with the next shot: extends its group, or starts one. Mutates `story` (call inside an update). */
export function joinNext(story: StoryDoc, shotId: string, newId: () => string, maxShots = MULTISHOT_MAX_SHOTS): void {
  if (!canJoinNext(story, shotId, maxShots)) return
  const next = story.shots[story.shots.findIndex((s) => s.id === shotId) + 1]!
  story.multishots = validGroups(story)
  const group = story.multishots.find((g) => g.shotIds.includes(shotId))
  if (group) {
    group.shotIds.push(next.id)
    // The takes (and their final render and cut records) were rendered for the shorter group.
    group.videoGenerationIds = []
    group.chosenAssetId = undefined
    group.finalGenerationId = undefined
    group.takes = undefined
  } else {
    // The first shot's "Render with…" choice becomes the new group's: the group renders both shots now.
    const modelId = story.shots.find((s) => s.id === shotId)?.modelId
    story.multishots.push({ id: newId(), shotIds: [shotId, next.id], videoGenerationIds: [], ...(modelId ? { modelId } : {}) })
  }
}

export function breakGroup(story: StoryDoc, groupId: string): void {
  story.multishots = (story.multishots ?? []).filter((g) => g.id !== groupId)
}

// The model's clip lengths live with its workflow profile (shared with the server); re-exported for the storyboard.
export { clipAtLeast, clipSeconds, maxClipSeconds }

export interface Cut {
  shot: StoryShot
  start: number
  end: number
}

const round1 = (n: number) => Math.round(n * 10) / 10

/**
 * The shots laid over a clip of `seconds`, each scaled in proportion to its planned length; with `minSeconds`, none
 * shorter than that when the clip has room for it — the time comes from the longer shots, in proportion to what they
 * have above the minimum.
 */
export function cutsForLength(shots: StoryShot[], seconds: number, minSeconds = 0): Cut[] {
  const sum = shots.reduce((a, s) => a + Math.max(1, s.duration), 0)
  const lengths = shots.map((s) => (Math.max(1, s.duration) * seconds) / sum)
  if (minSeconds > 0 && shots.length * minSeconds <= seconds) {
    const need = lengths.reduce((a, l) => a + Math.max(0, minSeconds - l), 0)
    const room = lengths.reduce((a, l) => a + Math.max(0, l - minSeconds), 0)
    if (need > 0 && room > 0) lengths.forEach((l, i) => (lengths[i] = l < minSeconds ? minSeconds : l - (need * (l - minSeconds)) / room))
  }
  let t = 0
  return shots.map((shot, i) => {
    const start = t
    const end = i === shots.length - 1 ? seconds : round1(t + lengths[i]!)
    t = end
    return { shot, start, end }
  })
}

/**
 * The group's shots on one clip: their lengths scaled to fit the model's longest clip (a whole number of seconds),
 * long enough for every shot to get `minSeconds` when the longest clip allows.
 */
export function planCuts(shots: StoryShot[], maxSeconds: number, minSeconds = 0): { total: number; cuts: Cut[] } {
  const sum = shots.reduce((a, s) => a + Math.max(1, s.duration), 0)
  const total = Math.max(2, Math.min(maxSeconds, Math.round(Math.max(sum, shots.length * minSeconds))))
  return { total, cuts: cutsForLength(shots, total, minSeconds) }
}

/**
 * The group's cuts on a clip this model renders: the longest clip caps the total, and a model with a few fixed lengths
 * (Veo: 4, 6 or 8 s) gets the next one up — otherwise the render is snapped afterwards and the prompt's "about 5
 * seconds" and its cuts no longer match the clip.
 */
export function planCutsFor(model: ModelSpec | undefined, shots: StoryShot[]): { total: number; cuts: Cut[] } {
  const min = workflowFor(model).multishot.minShotSeconds ?? 0
  const plan = planCuts(shots, model ? maxClipSeconds(model) : 10, min)
  const total = model ? clipAtLeast(model, plan.total) : plan.total
  return total === plan.total ? plan : { total, cuts: cutsForLength(shots, total, min) }
}

/**
 * The `planned.length` detected cuts that best match the plan, in order and without repeats: the subsequence with the
 * least total distance (a small DP). LTX adds stray cuts and drifts by seconds, so nearest-per-cut alone could pick
 * one cut twice or cross two over.
 */
export function matchCuts(planned: readonly number[], detected: readonly number[]): number[] {
  const k = planned.length
  const n = detected.length
  if (!k || n < k) return []
  // cost[i][j]: best total for the first i planned cuts using detected cuts before index j.
  const cost = Array.from({ length: k + 1 }, () => new Array<number>(n + 1).fill(Infinity))
  const took = Array.from({ length: k + 1 }, () => new Array<boolean>(n + 1).fill(false))
  cost[0]!.fill(0)
  for (let i = 1; i <= k; i++) {
    for (let j = i; j <= n; j++) {
      const skip = cost[i]![j - 1]!
      const take = cost[i - 1]![j - 1]! + Math.abs(detected[j - 1]! - planned[i - 1]!)
      took[i]![j] = take <= skip
      cost[i]![j] = Math.min(skip, take)
    }
  }
  const out: number[] = []
  for (let i = k, j = n; i > 0; j--) {
    if (took[i]![j]) {
      out.unshift(detected[j - 1]!)
      i--
    }
  }
  return out
}

export type TakeCutSource = 'detected' | 'planned' | 'proportional'

/** A stray opening shot is at most this long: LTX from references opens on an unasked-for two-shot of 0.6–1.1 s. */
const STRAY_OPENER_SECONDS = 1.5

/**
 * Where a group take changes shot: the detected cuts (matched to the plan when the picture has extra ones), else the
 * plan recorded when the take started (scaled to the real length), else the shots' current lengths. Cuts within
 * 0.2 s of the clip's ends are flashes, not shots. `start`: where the first shot begins when the take opens on a
 * stray shot of its own — an extra detected cut in the first 1.5 s, before the first one matched to the plan.
 */
export function takeCuts(
  shots: StoryShot[],
  seconds: number,
  rec?: { planned: number[]; total?: number; detected?: number[]; opener?: number },
): { cuts: number[]; source: TakeCutSource; found?: number; start?: number } {
  const want = shots.length - 1
  const proportional = cutsForLength(shots, seconds)
    .slice(1)
    .map((c) => c.start)
  const scale = rec?.total ? seconds / rec.total : 1
  const scaled = rec?.planned.map((t) => round1(t * scale))
  const inOrder = (cuts: number[]) => cuts.every((t, i) => t > (cuts[i - 1] ?? 0) && t < seconds)
  const planned = scaled?.length === want && inOrder(scaled) ? scaled : undefined
  const detected = rec?.detected?.filter((t) => t > 0.2 && t < seconds - 0.2)
  // An opening beat asked for (planning's openerShot) may run long; one LTX added by itself stays under 1.5 s.
  const openerEnd = rec?.opener ? round1(rec.opener * scale) : undefined
  const strayLimit = openerEnd ? Math.max(STRAY_OPENER_SECONDS, openerEnd * 2.5) : STRAY_OPENER_SECONDS
  if (detected && detected.length >= want) {
    const cuts = matchCuts(planned ?? proportional, detected)
    const stray = detected.filter((t) => t < Math.min(strayLimit, cuts[0] ?? seconds) && !cuts.includes(t)).at(-1)
    return { cuts, source: 'detected', found: detected.length, ...(stray !== undefined ? { start: stray } : {}) }
  }
  // Without the picture's cuts the opener ends where it was asked to.
  if (planned) return { cuts: planned, source: 'planned', found: detected?.length, ...(openerEnd ? { start: openerEnd } : {}) }
  return { cuts: proportional, source: 'proportional', found: detected?.length }
}

/** A shot's camera move in the render model's wording: a preset phrase picked for another model family is translated. */
export function cameraFor(camera: string, model?: ModelSpec): string {
  const preset = cameraOf(`Camera: ${camera}`)
  return (preset && cameraPhrase(preset.id, model)) || camera
}

/** Sentences joined without doubled stops ("…logo.. Camera"). */
export const sentences = (parts: (string | undefined | false)[]) =>
  parts
    .filter((p): p is string => Boolean(p && p.trim()))
    .map((p) => p.trim().replace(/[.\s]+$/, ''))
    .join('. ')

const clip = (text: string, max?: number) => (max && text.length > max ? `${text.slice(0, max).replace(/\s+\S*$/, '')}…` : text)

export interface MultishotPromptOptions {
  dialogue?: boolean
  sound?: boolean
  /**
   * The characters' looks from the Cast in each paragraph: in full (default), the first clause, or not at all — or
   * `once`: one sentence up top with each one's first clause, the lines naming them (LTX: every shot restating every
   * look made 456-word prompts, and Daniel came out in Claire's jumper).
   */
  looks?: 'full' | 'short' | 'none' | 'once'
  /** Characters sent as reference images, by id → "Image 1": named so in the shots and introduced once at the top. */
  subjects?: ReadonlyMap<string, string>
  /** Their voice samples, by id → "Audio 1". */
  voices?: ReadonlyMap<string, string>
  /** Who stands where in the scene ("Maja on the left at the ticket machine, Tymon on the right"), kept across the cuts. */
  blocking?: string
  /** The story's spoken language (see storyLanguage). */
  language?: string
  /** The place sent as the scene reference: its name, description and how the prompt calls it ("Image 3"). */
  scene?: { token: string; name: string; description: string }
  /** The place's one light logic, the same in every shot. */
  light?: string
  /** Shorten each shot's description to this many characters. */
  maxShotChars?: number
  /** The place sent as a photo described by its first clause only ("The inner courtyard of … at night"): the photo shows the rest. */
  sceneShort?: boolean
  /** The style is already written for the model (styleFor): use it as it is instead of dropping its "no …" phrases. */
  styleAsIs?: boolean
  /**
   * The clip starts from the first shot's keyframe: it shows who stands where, so a shot is placed only by what it
   * says itself (StoryShot.blocking) — sides worked out from the scene's blocking fought the picture.
   */
  fromFrame?: boolean
}

const article = (word: string) => (/^[aeiou]/i.test(word) ? 'an' : 'a')

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/**
 * The camera move as a plain sentence — Lightricks: labelled fields ("Camera: …") read as assembled, not filmed. A
 * preset that is a sentence stays one; a move ("slow dolly push-in about 15%, ending on her eyes") becomes "A slow
 * dolly push-in about 15%, ending on her eyes."
 */
export function cameraProse(phrase: string): string {
  const sentence = cameraSentence(phrase)
  const said = sentence.replace(/^Camera:\s*/i, '').trim()
  if (said === sentence.trim()) return sentence
  // A bare manner ("static", "handheld") names no move: it is the camera's.
  const move = CAMERA_NOUN.test(said) ? said : said.replace(/[.\s]*$/, ' camera.')
  return /^(the|a|an|camera)\b/i.test(move) ? capital(move) : capital(`${article(move)} ${move}`)
}

/** Words that make a camera phrase a move or a shot of its own ("push-in", "tracking", "pan", "hold"). */
const CAMERA_NOUN = /\b(camera|shot|frame|push|pull|dolly|pan|tilt|track|tracking|zoom|move|movement|orbit|arc|crane|jib|follow|hold|retreat|drift|whip|rack|reveal|circle|sweep)/i

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const listed = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}` : (xs[0] ?? ''))

/** Licon's axis sentence: "Image 1 is always established on the left side of the frame and Image 2 on the right side." */
function sidesSentence(sides: ReadonlyMap<string, ScreenSide>, nameOf: (id: string) => string): string {
  const on = (side: ScreenSide) => [...sides].filter(([, s]) => s === side).map(([id]) => nameOf(id))
  const [left, right] = [on('left'), on('right')]
  const verb = (xs: string[]) => (xs.length > 1 ? 'are' : 'is')
  if (left.length && right.length) return `${listed(left)} ${verb(left)} always established on the left side of the frame and ${listed(right)} on the right side.`
  if (left.length) return `${listed(left)} ${verb(left)} always established on the left side of the frame.`
  if (right.length) return `${listed(right)} ${verb(right)} always established on the right side of the frame.`
  return ''
}

/**
 * Where the people of one shot are on screen, so a reverse shot doesn't flip them: both faces → the place's blocking
 * (its whole composition, as Licon's opening two-shot does); one face over another's shoulder → Licon's "soft blurred
 * foreground shoulder" at that person's side, the face on its own side facing them; one face alone → its side and
 * which way it looks. An insert shows no one.
 */
function shotPlacement(
  shot: StoryShot,
  sides: ReadonlyMap<string, ScreenSide>,
  nameOf: (id: string) => string,
  blocking: string | undefined,
): string | undefined {
  if (/\binsert\b/i.test(shot.shotType ?? '')) return undefined
  const faces = shot.characterIds.filter((id) => sides.has(id))
  if (faces.length >= 2) return blocking
  if (faces.length !== 1 || shot.characterIds.length !== 1) return undefined
  const face = faces[0]!
  const side = sides.get(face)!
  const toward = oppositeSide(side)
  const behind = (shot.partialIds ?? []).find((id) => id !== face && sides.has(id))
  if (behind) {
    return `${nameOf(behind)} remains a soft blurred foreground shoulder at the ${sides.get(behind)} edge of the frame, and ${nameOf(face)}, on the ${side} side of the frame, faces ${toward} toward ${nameOf(behind)}`
  }
  const across = [...sides].find(([id, s]) => id !== face && s === toward)?.[0]
  const facing = across ? `, facing ${toward} toward ${nameOf(across)}` : ''
  // An extreme close-up is all face: only the eyeline, no side.
  return /\bextreme close|\bECU\b|\bmacro\b/i.test(shot.shotType ?? '')
    ? across && `${nameOf(face)} looks ${toward}, toward ${nameOf(across)}`
    : `${nameOf(face)} is on the ${side} side of the frame${facing}`
}

/**
 * The style without its negative phrases ("…, no subtitles, no logos" → "…"): Lightricks' guide says not to rely on
 * negative phrasing, and naming subtitles or logos to LTX can draw them in. Nor its camera moves ("slow sweeping crane
 * and drone camera"): every shot says its own, and a style's slow crane fought a shot's rapid drone ascent (Kael).
 */
export function positiveStyle(style: string): string {
  return style
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part && !/^(no|without|avoid)\b/i.test(part) && !/\b(crane|drone|dolly|camera)\b/i.test(part))
    .join(', ')
}

/**
 * A place's description without its compass geography ("From the establishing camera… looking east: … North of the
 * plain (screen left): …"), for a video prompt that sends the place's photo along: the photo shows the layout, and the
 * compass read against a shot's "behind him: the northern edge" as two camera directions. The first sentence stays.
 */
export function withoutCompass(description: string): string {
  const parts = description.trim().split(/(?<=[.;])\s+/)
  const compass = /\b(north|south|east|west)(ern|ward|wards)?\b|establishing camera|behind the camera|screen (left|right)/i
  const kept = parts.filter((part, i) => i === 0 || !compass.test(part))
  return kept.join(' ')
}

/** A pronoun or a name ("Behind him", "Behind Claire"), then what is there: a colon, or "lies", "stands", "rises"… */
const BACKDROP = /^\s*Behind\s+(?:him|her|them|it|us|\p{Lu}[\p{L}'’-]*)(?![\p{L}])(?:[^.!?]*:|\s+(?:lies|lie|stands|stand|rises|rise|stretches|stretch|looms|loom|is|are)\b)/u

/**
 * A shot's action without the sentences that say what is behind the subject ("Behind him, across the road: the open
 * field with hay bales."), for a clip rendered from its keyframe: the picture already shows it, and saying it again
 * describes the frame instead of what happens next (Lightricks' image-to-video advice). "Behind her, Daniel draws a
 * gun." is action and stays.
 */
export function withoutBackdrop(text: string): string {
  const parts = text.trim().split(/(?<=[.!?])\s+/)
  const kept = parts.filter((part) => !BACKDROP.test(part))
  return kept.length === parts.length ? text : kept.join(' ')
}

/**
 * The style's negative phrases as negative-prompt terms ("…, no subtitles, without logos" → ["subtitles", "logos"]):
 * what positiveStyle drops, for a model whose negative prompt works.
 */
export function styleNegatives(style: string): string[] {
  return style
    .split(',')
    .map((part) => part.trim())
    .filter((part) => /^(no|without|avoid)\b/i.test(part))
    .map((part) => part.replace(/^(no|without|avoid)\s+/i, '').trim())
    .filter(Boolean)
}

/**
 * The story's style as this model should read it. LTX gets it without the negative phrases (above: its negative
 * prompt does nothing), and so does a model with a working negative prompt — "no subtitles" goes there. Any other
 * model (Kling, Seedance, Wan…) has only the prompt, so the style keeps its "no …" phrases, and a model that speaks
 * the lines is also told to keep them off the screen.
 */
export function styleFor(style: string, model: ModelSpec | undefined, speaks: boolean): string {
  if (workflowFor(model).negative !== 'none') return positiveStyle(style)
  const kept = style.trim().replace(/[.,\s]+$/, '')
  return speaks && !/subtitle/i.test(kept) ? [kept, 'no subtitles, no on-screen text'].filter(Boolean).join(', ') : kept
}

/**
 * The multi-shot prompt, written the way Lightricks' prompting guide asks: prose, not a shot list or labelled fields,
 * no timestamps or seconds (the clip's length is a request setting) — each cut is named in words ("A hard cut
 * transitions to an over-the-shoulder close-up shot…") with the framing set again, then the action. Referenced
 * characters are introduced once (Licon's "Image 1: …" lines), then one line keeps the camera axis and everyone's
 * place across the cuts. `_total` (the clip's length) is not written: the cuts carry the shots' order only. The last
 * shot's settle after its last line is in its timing (END_SETTLE_SECONDS), not in words.
 */
export function multishotPrompt(
  cuts: Cut[],
  _total: number,
  characters: StoryCharacter[],
  style: string,
  opts: MultishotPromptOptions = {},
): string {
  // No seconds anywhere: the clip's length is a request setting, and the model reads none (Lightricks' guide).
  const header = `A multi-shot sequence of ${cuts.length} shots joined by hard cuts.`
  const subjects = opts.subjects?.size ? opts.subjects : undefined
  const named = (text: string) => (subjects ? withSubjects(text, characters, subjects) : text)
  const nameOf = (id: string) => subjects?.get(id) ?? titleCase(characters.find((c) => c.id === id)?.name ?? '')
  const voices = opts.voices?.size ? opts.voices : undefined
  const voiceLines =
    voices &&
    [...voices]
      .map(([id, audio]) => audioBlock(audio, characters.find((c) => c.id === id), subjects?.get(id) ?? id))
      .join('.\n\n')
  const scene = opts.scene
  const sceneText = scene && (opts.sceneShort ? scene.description.split(/[:;.]/)[0]! : withoutCompass(scene.description)).trim().replace(/[.,\s]+$/, '')
  const sceneLine = scene && `${scene.token}: Scene, ${sceneText}`
  // Licon's MSR template: one block per reference, the voices, then one line that holds the axis across the cuts.
  const intro = subjects && `${[subjectsPreamble(characters, subjects).split('. Image ').join('.\n\nImage '), sceneLine, voiceLines].filter(Boolean).join('.\n\n')}.`
  const blocking = opts.blocking?.trim().replace(/[.\s]+$/, '')
  const light = opts.light?.trim().replace(/[.\s]+$/, '')
  // Who holds which side, from the blocking (the people in this clip only).
  const present = new Set(cuts.flatMap((c) => shotCast(c.shot)))
  const visible = (id: string) => present.has(id) && !isUnseen(characters.find((c) => c.id === id) ?? { id, name: '', description: '' })
  const sides = new Map([...screenSides(blocking, characters)].filter(([id]) => visible(id)))
  const established = sidesSentence(sides, nameOf)
  // Licon's axis line says only who is on which side: the blocking's whole composition ("by the fountain, the doors
  // behind her") before shot 1 is drawn as a shot of its own — a stray establishing beat that also takes the first line.
  // That composition goes into the shots that show both faces instead. A blocking that names no sides stays here.
  // Who keeps their looks, by name: "Preserve everyone's identity, wardrobe and screen position" said "everyone" of one
  // man, and "screen position" of a man who shrinks to a speck as the camera rises (Kael). The axis — the camera never
  // crossing to the other side — matters only between people; "remains fixed" also read as a locked camera.
  const people = [...present].filter(visible).map(nameOf).filter(Boolean)
  const keep = people.length ? `Keep ${people.length > 1 ? `${listed(people.map((n) => `${n}'s`))} faces` : `${people[0]}'s face`}, hair and clothes the same across every cut.` : ''
  // Each look once, by who they are (the first clause): the shots and lines name them.
  const once = opts.looks === 'once'
  const castLine = once
    ? [...present]
        .filter((id) => visible(id) && !subjects?.has(id))
        .map((id) => lookOf(characters.find((c) => c.id === id)!, true))
        .filter(Boolean)
        .map((look) => `${look}.`)
        .join(' ')
    : ''
  const axis = [
    established ? `${sides.size > 1 ? 'The camera stays on the same side of the action across every cut, never crossing or circling round it. ' : ''}${established}` : blocking && `${named(blocking)}.`,
    keep,
    light && `${capital(light)}, the same in every shot.`,
  ]
    .filter(Boolean)
    .join(' ')
  /** A framing in lower case ("OVER-THE-SHOULDER CLOSE-UP from behind Image 2"), its tokens and names kept as they are. */
  const quiet = (text: string) => {
    const kept: string[] = []
    const keep = (word: string) => `\u0000${kept.push(word) - 1}\u0000`
    let out = text
    for (const t of subjects?.values() ?? []) out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(t)}(?![\\p{L}\\p{N}_])`, 'gu'), keep)
    for (const c of characters) {
      const name = c.name.trim()
      if (name) out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(name)}(?![\\p{L}\\p{N}_])`, 'giu'), () => keep(titleCase(name)))
    }
    return out.toLowerCase().replace(/\u0000(\d+)\u0000/g, (_, i: string) => kept[Number(i)]!)
  }
  const paragraphs = cuts.map((c, i) => {
    const s = c.shot
    const framing = s.shotType?.trim() && named(/\bshot$/i.test(s.shotType.trim()) ? s.shotType.trim() : `${s.shotType.trim()} shot`)
    // The first shot opens on its framing; every later one is introduced as a cut to its framing and where the camera
    // now stands (the guide's wording) — a cut within one place with nothing but a closer framing came out a push-in.
    const where = scene ? ` in ${scene.name} matching ${scene.token}` : ''
    const from = viewFrom(s.view)
    const opening =
      i === 0
        ? framing && `${framing}${where}`
        : `A hard cut transitions to ${framing ? `${article(framing)} ${quiet(framing)}` : 'the next shot'}${from ? ` from ${named(from)}` : ''}`
    const own = s.blocking?.trim().replace(/[.\s]+$/, '')
    const placement = opts.fromFrame ? own && named(own) : established ? shotPlacement(s, sides, nameOf, blocking && named(blocking)) : undefined
    // The guide: the cut and the new framing, then the action first — who stands where follows it.
    const body = clip(sentences([opening, named(s.prompt), placement, s.camera && named(cameraProse(s.camera))]), opts.maxShotChars)
    // Restated in every paragraph, word for word (LTX keeps a subject when it is described the same way each time) —
    // unless they were said once up top: the lines then name the speakers too.
    const looks = opts.looks === 'none' || once ? '' : castLooks(s, characters, opts.looks === 'short', subjects)
    const track = soundtrackPrompt(s, characters, { dialogue: opts.dialogue, sound: opts.sound, subjects, voices, language: opts.language, brief: once })
    return `${body}.${looks ? ` ${looks}.` : ''}${track ? ` ${track}` : ''}`
  })
  return [header, intro, castLine, axis, ...paragraphs, opts.styleAsIs ? style : positiveStyle(style)].filter(Boolean).join('\n\n')
}

/** Where a cut's camera stands, from the shot's view ("on the bank behind them, looking out…" → "the bank behind them"). */
function viewFrom(view: string | undefined): string | undefined {
  const first = view?.split(/[,;:.]/)[0]?.trim()
  return first ? first.replace(/^(?:on|at|from)\s+/i, '') : undefined
}

/** What the shrink ladder turns down, step by step, to fit a clip's prompt into the model's limits. */
export type ClipKnobs = Pick<MultishotPromptOptions, 'dialogue' | 'sound' | 'looks' | 'maxShotChars' | 'sceneShort'>

/**
 * The shrink ladder, richest first: shorten the place that goes as a photo to its first clause (the photo shows the
 * rest), drop the sounds, shorten the looks to who they are, shorten the shots, and only then drop the dialogue and
 * the looks — a model that speaks the lines would otherwise render a silent scene (Kling's 2500-character prompt lost
 * every line to a long style and place description before a shot was shortened; LTX lost its rain to a long scene).
 */
export const SHRINK_LADDER: readonly ClipKnobs[] = [
  {},
  { sceneShort: true },
  { sceneShort: true, sound: false },
  { sceneShort: true, sound: false, looks: 'short' },
  ...[900, 650, 450, 300].map((maxShotChars) => ({ sceneShort: true, sound: false, looks: 'short' as const, maxShotChars })),
  { sceneShort: true, sound: false, dialogue: false, looks: 'short', maxShotChars: 300 },
  { sceneShort: true, sound: false, dialogue: false, looks: 'none', maxShotChars: 300 },
]

/**
 * The richest compiled clip that `fits`, for any prompt dialect: each ladder step's knobs (with `ctx` on top) go to
 * `compile`; the last step's result when nothing fits.
 */
export function fitClip<T, C extends object = object>(compile: (opts: ClipKnobs & C) => T, fits: (out: T) => boolean, ctx: C = {} as C): T {
  let out: T | undefined
  for (const knobs of SHRINK_LADDER) {
    out = compile({ ...knobs, ...ctx })
    if (fits(out)) return out
  }
  return out!
}

/** The richest LTX multi-shot prompt that fits the model's limit (fitClip over multishotPrompt). */
export function fitMultishotPrompt(
  cuts: Cut[],
  total: number,
  characters: StoryCharacter[],
  style: string,
  fits: (prompt: string) => boolean,
  context: Pick<MultishotPromptOptions, 'subjects' | 'voices' | 'blocking' | 'language' | 'scene' | 'light' | 'styleAsIs'> = {},
): string {
  return fitClip((opts) => multishotPrompt(cuts, total, characters, style, opts), fits, context)
}
