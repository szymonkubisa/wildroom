import { z } from 'zod'
import { EXPLAINER_STYLES, EXPLAINER_STYLE_IDS, type ExplainerStyleId } from '../../shared/motion/explainerStyles'
import { soloEndFrameShots, soloSpeakingShots, splitGroups } from '../../shared/models/groups'
import { getModel } from '../../shared/models/registry'
import type { ModelSpec } from '../../shared/models/types'
import { type VideoMultishot, type VideoWorkflow, followsRecordedAudio, rendersSeparately, workflowFor } from '../../shared/models/workflow'
import type { EnhanceReference, EnhanceRequest, TrimDialogueRequest, TrimDialogueResponse } from '../../shared/types/api'
import {
  type Breakdown,
  type BreakdownRequest,
  type BreakdownResponse,
  type BreakdownShot,
  type ImproveLookRequest,
  type ImproveLookResponse,
  type Outline,
  type OutlineRequest,
  type OutlineResponse,
  PLACE_VIEWS,
  type PlaceView,
  type PlaceViewRequest,
  type PlaceViewResponse,
  type SceneShotsRequest,
  type SceneShotsResponse,
  type WriteScriptRequest,
  type WriteScriptResponse,
} from '../../shared/types/story'
import { type DirectorContext, type DirectorPlanRequest, type DirectorPlanResponse, PLAN_OPS, PLAN_STEPS_MAX, type PlanOp, type PlanStep, planStepSchema } from '../../shared/director/plan'
import { ApiError } from '../http'
import { type LlmContent, type LlmCredentials, type LlmPart, llmStructured } from './llm'
import { WORDS_PER_SECOND, countWords, leadingTags, secondsForLines, speakableText, withoutLeadingTags } from './speechText'

// Plain field types only (structured outputs support a JSON-schema subset); ranges are enforced after parsing.
const breakdownSchema = z.object({
  title: z.string(),
  characters: z.array(z.object({ name: z.string(), description: z.string(), voice: z.string() })),
  places: z.array(z.object({ name: z.string(), description: z.string(), blocking: z.string(), light: z.string() })),
  shots: z.array(
    z.object({
      scene: z.string(),
      place: z.string(),
      description: z.string(),
      shotType: z.string(),
      camera: z.string(),
      prompt: z.string(),
      durationSeconds: z.number(),
      characters: z.array(z.string()),
      partial: z.array(z.string()),
      dialogue: z.array(z.object({ character: z.string(), text: z.string() })),
      sfx: z.string(),
      group: z.number(),
    }),
  ),
})

const promptSchema = z.object({ prompt: z.string() })

/** The model the Director writes for: a video model by id, else none (the system prompt is then written for LTX-2.5). */
export function breakdownTarget(id?: string): ModelSpec | undefined {
  const model = id ? getModel(id) : undefined
  return model?.kind === 'video' ? model : undefined
}

/**
 * The target renders a shot where someone speaks on its own, from its keyframe, made to the line's recorded voice (LTX
 * with audio to follow; none = LTX-2.5 on the GPU): dialogue never goes into a multi-shot group.
 */
export const soloDialogueFor = (model: ModelSpec | undefined) => followsRecordedAudio(model, true)

/** "Kling 3.0 (fal)" → "Kling 3.0": where it runs doesn't change how it is written for. */
const familyLabel = (model: ModelSpec | undefined, fallback: string) => model?.label.replace(/\s*\([^)]*\)/g, '').trim() || fallback

const listed = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`)

/** What the target model needs from the breakdown: one paragraph per family, the limits from its workflow profile. */
function familyGuidance(model: ModelSpec | undefined, w: VideoWorkflow): string {
  const { maxShots, maxSeconds } = w.multishot
  const speech = Array.isArray(w.speech.languages)
    ? ` It voices dialogue in ${listed(w.speech.languages)}; a line in another language is translated when it is spoken, so give every line room to be spoken within its shot.`
    : ''
  switch (w.dialect) {
    case 'ltx': {
      const lead = `The model is LTX-2.5, Lightricks' audio-video model. Write everything the way Lightricks' prompting guide asks: concrete, present tense, physical, no negative phrasing.`
      // Lightricks: image-to-video is told what happens next, not what the start frame already shows.
      if (rendersSeparately(model, true)) {
        return `${lead} Every shot is rendered as its own image-to-video clip from its keyframe: its prompt starts with the action and says what happens next from that still picture, which already shows the place, the people and the light. A shot can also be rendered between its keyframe and an end keyframe from the same camera: it then lands exactly on the end picture.${soloDialogueFor(model) ? ' A shot where someone speaks is made to the line as a voice actor recorded it (exact words and lip sync): give each line to the shot of the person who says it, facing the camera, one speaker per shot.' : ''}`
      }
      return `${lead} A multi-shot clip is written as prose, each cut named in words. Each shot in a multi-shot clip needs about 3 seconds (a cut every 2 seconds plays like a slideshow), a multi-shot clip opens on a shot that shows everyone in it (a wide or a two-shot; close-ups and over-the-shoulders come after), and nothing is said in its last second — it ends on a settle. A shot can also be rendered between a start frame and an end frame: it then lands exactly on the end picture.${soloDialogueFor(model) ? ' A shot where someone speaks is rendered on its own from its keyframe, made to the line as a voice actor recorded it (exact words and lip sync): give each line to the shot of the person who says it, facing the camera, one speaker per shot.' : ''}`
    }
    case 'kling': {
      const clip =
        w.multishot.method === 'native'
          ? `It renders multi-shot natively: one clip takes its own shot list of up to ${maxShots} shots and ${maxSeconds} seconds, each shot at least 1 second.`
          : `A multi-shot clip is written as prose, each cut named in words: up to ${maxShots} shots and ${maxSeconds} seconds.`
      return `The model is ${familyLabel(model, 'Kling 3.0')}, Kling's audio-video model. ${clip} Write concrete, present-tense, physical action. Give every character one exact name and use it the same way in every shot — the names tie each shot to the cast.${speech}`
    }
    case 'veo':
      return `The model is ${familyLabel(model, 'Veo 3.1')}, Google's audio-video model. Its clips last at most ${maxSeconds} seconds, so most shots stand alone and a multi-shot clip is 2–3 short shots. Phrase everything positively: describe what is there, never what is absent or should be avoided.${speech}`
    case 'happyhorse':
      return `The model is ${familyLabel(model, 'Happy Horse 1.1')}, an audio-video model: its clips last up to ${maxSeconds} seconds, and a multi-shot clip is written as beats ("Begin with… Cut to…"), up to ${maxShots} per clip. It lip-syncs each speaker from the dialogue, so attribute every line to the character who says it and keep the speaker's face in the shot. Write concrete, present tense, physical action.${speech}`
    case 'generic':
      return `The model is ${familyLabel(model, 'an audio-video model')}. Write everything concrete, present tense and physical, with no negative phrasing. A multi-shot clip is written as prose, each cut named in words.${speech}`
  }
}

/** The "group" rule: how many shots, and how long together, one multi-shot clip of the model takes. */
function groupRule(w: VideoWorkflow): string {
  const { maxShots, maxSeconds } = w.multishot
  return w.dialect === 'veo'
    ? `at most ${maxSeconds} seconds together, so prefer single shots or 2–3 short ones`
    : `${maxShots > 2 ? `2 to ${maxShots}` : '2'} shots, at most ${maxSeconds} seconds together`
}

/**
 * The "group" field's line: what may share a multi-shot clip — on LTX nothing (rendersSeparately: its shots render one
 * by one, and the user joins them into one clip), else with LTX only shots without dialogue (soloDialogueFor).
 */
function groupLine(w: VideoWorkflow, soloDialogue: boolean, separate: boolean): string {
  if (separate) return `- "group": always 0 — every shot is rendered as a clip of its own.`
  return soloDialogue
    ? `- "group": shots where nobody speaks — an establishing shot, arrivals and movement, silent reactions, inserts — that should play as one multi-shot clip get the same number, one after another — ${groupRule(w)}. A shot with dialogue always gets 0: it is rendered on its own, lip-synced to the recorded line.`
    : `- "group": shots that should play as one multi-shot clip get the same number, one after another — ${groupRule(w)}, usually an exchange of lines in one place; any other shot gets 0.`
}

const INTRO = `You are an experienced film director and storyboard artist preparing a short film for an AI video model that renders each shot from a keyframe, or a short multi-shot clip from reference images of the characters and the place.`

const PLACES_RULES = `Places (top level "places", each distinct location once):
- "description": what it looks like — architecture, materials, surroundings — and its geography: what lies on each side of where the action happens ("north of the road: an open field with hay bales; south, behind the parked cars: tall grass and a row of birches"), so a reverse shot can show the opposite side. Distant landmarks (a smoke column on the horizon, planets in the sky) belong to the geography too, on the side where they are.
- "blocking": who stands where and which way they face, from the establishing camera's point of view ("Anna on the left at the window, facing right; Tomek on the right by the door, facing left"). Every shot there keeps these sides (180° rule).
- "light": one coherent light logic — source, direction, colour, time of day ("low golden evening sun from the left, long soft shadows"). Never mix light sources within a place. It is a steady state that holds in every shot: no events (headlights that come on are an action of the shot they come on in) and no distant landmarks (they are in the description).`

const CAST_RULES = `Characters (top level "characters"): a consistent look — "Name, age, build, face and hair; clothing and distinguishing features". The first clause (up to the first ";", under 90 characters) says who they are and their face and hair. This is the only place a look is written. "voice": how they sound, starting with the gender, with the accent when the script implies one ("warm, low female voice with a soft Mexican accent that trembles but holds", "deep, quiet, slightly rough male voice") — from the script's voice notes when it has them; video models that speak the lines are told it with every line.`

/** What is behind the subject from the camera: the end of a shot's prompt in the one-pass breakdown, of its "frame" per scene. */
const BEHIND = `what is seen behind the subject from this camera position, from the place's geography ("Behind him, across the road: the open field with hay bales") — an over-the-shoulder shot and its reverse look in opposite directions, so their backgrounds are opposite sides of the place. Name what is behind by its landmarks, never by compass directions ("the northern edge") or screen sides.`

/**
 * How every shot is written, the same in the one-pass breakdown and a scene's shots (field rules, then the group line).
 * `framed`: the shots have a "frame" (the scene-by-scene pass), which says what is behind the subject — the prompt
 * then only says what happens: rendered from the keyframe, a prompt ending "Behind him: …" described the picture again.
 */
function shotRules(model: ModelSpec | undefined, w: VideoWorkflow, framed = false): string {
  const separate = rendersSeparately(model, true)
  return `Shots — split the script into shots of 2–8 seconds; each is one continuous camera setup:
- "shotType": the framing — scale, angle and lens ("MEDIUM CLOSE-UP, eye level, 50mm", "OVER-THE-SHOULDER CLOSE-UP"). Use INSERT for hands or objects only.
- "prompt": the action only — what happens, in order, with verbs and the beats and pauses written in ("she pauses", "a beat of silence"); emotion through physical cues ("presses her lips together", "his shoulders drop"), not labels like "angry". Refer to characters by their exact names; never describe their looks, the camera, the light or the dialogue here — only a light that switches on or goes out in this shot, which is part of its action. Name materials, particles and props exactly, in the same words in every shot ("grey ash flakes" every time — never just "flakes", which was drawn as snow). Two to four sentences; few characters and simple, plausible motion — about one clear action per 2–3 seconds of the shot. ${framed ? 'The "frame" already shows who is where and what is behind them: the prompt says only what happens next.' : `End with ${BEHIND}`} Give gaze and movement directions by landmarks ("looks toward the smoke", "walks toward the Nissan"), never as left or right: for someone facing the camera their left is the frame's right. Everyone looks at a person or a landmark, never into the lens.
- "camera": the movement relative to the subject with its direction and speed, and the frame it ends on ("slow dolly push-in, ending on her face"; "rises until the whole square fits the frame"); or "locked-off static camera". Never percentages, multiples or heights — say what the frame shows at the end. One readable composition per shot: a view straight down can't also hold the horizon.
- "characters": who is seen with their face. "partial": who is in the frame only from behind or in part (the foreground shoulder of an over-the-shoulder shot, a pair of hands) — they don't lip-sync.
- "dialogue": the spoken lines in order, each attributed to a character name, in the script's own words and language — never change, translate or shorten the spoken words. Split a line into short phrases and put one acting cue in square brackets between phrases (an eye-line shift, a pause, a voice quality, a small gesture), e.g. "Przyjmuje. [glances at the machine] Jak chce." A cue in brackets at the very start sets the delivery ([quietly], [warm and dry], [muttering]). Write cues in English. Keep speech at most about 2.5 words per second of the shot.
- "sfx": the ambience and effects as 2–3 concrete sound sources ("rain drumming on the car roof, a distant siren, footsteps on wet concrete"), and whether the ambience carries over from the previous shot ("the platform ambience continues; a door hisses shut").
- "durationSeconds": long enough for the action and the speech: about 2–3 seconds per action, and for lines a moment before the first word and after the last, a quarter second between two lines, and a second for every 2.5 spoken words (two lines of 9 words: 9 seconds).
${groupLine(w, soloDialogueFor(model), separate)} ${separate ? 'Each shot' : 'Each shot of a group'} moves the action on to its next state — never the same event again from another angle.`
}

const COVERAGE_RULES = `Coverage: cover a conversation like a film — an establishing shot that sets the blocking, then over-the-shoulder shots (the listener's shoulder and back of the head soft in the foreground, the speaker facing the camera) and reverse shots, always from the same side of the line. Close-ups are taken from where the characters already stand. Keep wardrobe, props and light continuous. Respect the requested visual style and aspect ratio.`

/**
 * The Director's system prompt for the target video model (none: LTX-2.5, the storyboard's default): a model-neutral
 * brief, one paragraph for the model's family, and the group rule from its workflow profile. The JSON shape is the
 * same for every model.
 */
export function breakdownSystem(model?: ModelSpec): string {
  const w = workflowFor(model)
  return `${INTRO}

${familyGuidance(model, w)}

${PLACES_RULES}

${CAST_RULES}

${shotRules(model, w)}
- "description": a one-line summary for the editor. "scene": the scene heading. "place": the name of its location from "places" (empty if none fits).

${COVERAGE_RULES}`
}

/**
 * The first of the two passes: the world and the structure — cast, places, chapters and their scenes — before any shot
 * is planned, so the cast can be checked (and given pictures) before shots are written for it.
 */
export function outlineSystem(): string {
  return `You are an experienced film director and script editor preparing a short film for an AI video model. Before any shot is planned, break the script into its world and its structure: the characters, the places, and the scenes in order, grouped into chapters.

${PLACES_RULES}
A location seen in several scenes is one place (a shore and its pier, a house and its porch), its description covering all of it; a place's "blocking" is only what holds in every scene there — where people are in one scene goes in that scene's "blocking".

${CAST_RULES}

Chapters (top level "chapters", in order): the story's movements — a setup, a turn, a resolution — each with a short "title" and a one-sentence "summary". A short film may have a single chapter.

Scenes (each chapter's "scenes", in story order) — a scene is one continuous piece of action in one place at one time; a new scene starts whenever the place or the time jumps:
- "heading": a short scene heading naming the place and the time ("Roadside past Włoszczowa — dusk").
- "place": the name of its location, exactly as written in "places" — every scene has one.
- "time": the time of day.
- "light": the light in this scene — source, direction, colour — true to the place and the time of day; a steady state with no events (a light that switches on is an action of the shot it happens in) and no distant landmarks (they are in the place's description).
- "blocking": where everyone stands at the scene's start, by screen sides from the establishing camera, only when it differs from the place's blocking; else empty.
- "characters": the names of everyone in the scene.
- "summary": what happens, in one or two present-tense sentences.
- "opening": the first 6–12 words of the scene's part of the script, copied exactly as written, starting with its scene heading when it has one — the script is cut into scenes at these words.
- "seconds": roughly how long the scene plays on screen.
- "continuesPrevious": true only when the scene picks up exactly where the previous one ends, with no jump in time.

Stage the action so it can be filmed: people talk standing or sitting where the camera sees their faces — never through a car window or inside a moving car. Cover the whole script in order without leaving anything out, and don't add scenes the script doesn't have (for a one-line idea, write the few scenes it needs). Also give the film a "title" and a "logline": the story in one sentence.`
}

/**
 * The second pass: the shots of one scene, written for the target video model with the cast, the place and the
 * scene's light as they are set — the same shot rules as the one-pass breakdown, plus what one scene needs.
 */
export function sceneShotsSystem(model?: ModelSpec): string {
  const w = workflowFor(model)
  return `${INTRO}

${familyGuidance(model, w)}

You are writing the shots of one scene of the film. Its characters, its place and its light are already set — the user prompt gives them: use the characters' exact names and never describe their looks.

${shotRules(model, w, true)}
- "description": a one-line summary for the editor.
- "view": where the camera stands and which way it looks, by the place's landmarks ("on the bank behind them, looking out along the pier to the lake"; "at the pier's end, looking back at the bank, over Kuba's shoulder onto Stefan's face"). An over-the-shoulder shot names whose shoulder; its reverse looks the opposite way.
- "frame": the shot's first moment as one still picture, for its keyframe — everyone in it: where in the frame (screen left or right, near or far), which way they face the camera (toward it, three-quarter, in profile, back to it), what they look at (a person or a landmark, never the lens), their pose, hands and what they hold, their expression; then ${BEHIND} One state, no "then": what happens next is the prompt's.
- "hidden": who is in the frame only as an unreadable dark outline or silhouette — someone already there, unseen in the shadows, who is revealed later: no face and no lines, and they are in neither "characters" nor "partial". Else empty.
- "background": which of the place's four views lies behind the subject from this camera — "main" (the way the place's main photo looks, the establishing view), "reverse" (looking back toward where the establishing camera stands), "left" or "right" (turned 90° to the left or right of the main view); the nearest one. A shot and its reverse look different ways: two people side by side facing the main view, turned to each other, are filmed toward "left" over one's shoulder and toward "right" over the other's; someone filmed from in front while they look out at the main view has the "reverse" behind them. Use all four when the action needs it — never keep the main view behind everyone.
- "endFrame": only when the shot ends on a large, clearly visible change its first frame can't show — a structure rising out of the ground, a transformation, something appearing, opening, breaking or moving somewhere else — seen from exactly the same camera as "frame" (the same framing and lens, nothing recomposed). Its first sentence says what changed and what is no longer where it was ("The phone is no longer on the floor; it is in her raised hand."); then the shot's last moment as one still picture, in the same form as "frame". Its end keyframe is drawn and the clip is rendered between the two frames, so the change must show at a glance: an end that barely differs from the start freezes the clip, and one from another camera cuts in the middle of it. A shot with an endFrame plays on its own: its "group" is 0. Never for a camera move (a drone flight, a climb, a long push): a start and an end far apart make the model morph the place into the end picture — a tower rising out of the water — instead of travelling to it; the first frame and the "camera" text carry a move. Never for a shot where someone speaks. Else empty.

Scene rules:
- Shot 1 is a WIDE establishing shot in the composition of the place's main photo, showing everyone who is there when the scene starts, already in place and in plain view; every later keyframe takes its layout from it. Someone who arrives or is revealed later is left out of it — or, when they are already there unseen, listed in "hidden". Only when the scene continues straight on from the previous one does shot 1 pick up from that scene's last shot instead.
- A keyframe is one moment: every shot starts from one still state, and its prompt says what happens next — never two positions of the same person.
- A transformation (something emerging, building, changing shape) is split into stages, one shot each with its own frame and endFrame — it begins, it spreads, it completes — each stage a clip of its own (group 0), and the last stage's endFrame shows the finished result. Keep the camera still while the world transforms; a large camera move is a shot of its own, without an endFrame.
- Each shot of a sequence is filmed from a clearly different camera than the shot before — another side, distance or height (low at his boots, in profile, straight down, far above) — so every cut reads; never the same view again from a little higher.
- The shot after one with an endFrame opens on that same moment: its "frame" is the previous endFrame's state, seen from its own camera.
- Stage dialogue with people standing or sitting turned toward each other where the camera sees their faces — never through a car window or inside a moving car. Whoever speaks faces the camera at least three-quarter, so the view goes where their face is: people looking out at a view are filmed from in front of them, not from behind.
- Keep the scene's time of day, light, wardrobe and props in every shot; a prop stays in the same hands until a shot shows it handed over or put down. The light is a steady state: a light that switches on or goes out (headlights, a lamp) does so in one shot's prompt; every frame before that shot shows it as it was, every frame after as it is left.
- Cover only this scene's part of the script, all of it, in order, and end on a shot that can cut away to the next scene.

${COVERAGE_RULES}`
}

/** Keys plus the chosen text model (Settings → AI Director). */
export type DirectorCredentials = LlmCredentials

function userPrompt(req: BreakdownRequest): string {
  const parts = [`Script or idea:\n"""\n${req.script.trim()}\n"""`]
  if (req.style?.trim()) parts.push(`Visual style: ${req.style.trim()}`)
  if (req.aspect) parts.push(`Aspect ratio: ${req.aspect}`)
  if (req.characters?.length) {
    parts.push(`Existing characters (keep these names and looks):\n${req.characters.map((c) => `- ${c.name}: ${c.description}${c.voice ? ` Voice: ${c.voice}` : ''}`).join('\n')}`)
  }
  if (req.places?.length) {
    parts.push(
      `Existing places (keep these names, looks, blocking and light):\n${req.places
        .map((p) => `- ${p.name}: ${p.description}${p.blocking ? ` Blocking: ${p.blocking}` : ''}${p.light ? ` Light: ${p.light}` : ''}`)
        .join('\n')}`,
    )
  }
  if (req.targetShots) parts.push(`Aim for about ${req.targetShots} shots.`)
  return parts.join('\n\n')
}

/** A shot as the model wrote it: its background still free text. */
type RawShot = Omit<BreakdownShot, 'background'> & { background?: string }

/** A shot's background as one of the place's four views ("Left" → "left"); anything else is dropped. */
const placeView = (value: string | undefined): PlaceView | undefined => {
  const v = value?.trim().toLowerCase()
  return PLACE_VIEWS.find((x) => x === v)
}

/** Names trimmed, each once (any case), by their lower case. */
function byName(names: readonly string[] | undefined): Map<string, string> {
  const out = new Map<string, string>()
  for (const name of names ?? []) if (name.trim() && !out.has(name.trim().toLowerCase())) out.set(name.trim().toLowerCase(), name.trim())
  return out
}

/**
 * The shots part of sanitizeBreakdown, for a whole breakdown or one scene: durations clamped (and long enough for the
 * lines, within one clip), text trimmed, empty shots dropped, and the groups cut to what one clip of the target model
 * takes — none at all when it renders shot by shot (`separate`, see rendersSeparately).
 */
export function sanitizeShots(
  shots: readonly RawShot[],
  limits: Pick<VideoMultishot, 'maxShots' | 'maxSeconds'> = workflowFor(undefined).multishot,
  opts: { soloDialogue?: boolean; separate?: boolean } = {},
): BreakdownShot[] {
  const cleaned = shots
    .filter((s) => s.prompt.trim() || s.description.trim())
    .slice(0, 80)
    .map(({ view, frame, endFrame, background, hidden, ...s }) => {
      const dialogue = s.dialogue.filter((d) => d.text.trim())
      const asked = Math.min(15, Math.max(2, Math.round(Number(s.durationSeconds) || 5)))
      // Someone hidden in the shadows has no face in the shot: they are neither in it with their face nor in part.
      const unseen = byName(hidden)
      const seen = (names: readonly string[]) => names.filter((n) => !unseen.has(n.trim().toLowerCase()))
      return {
        ...s,
        ...(unseen.size ? { characters: seen(s.characters), ...(s.partial ? { partial: seen(s.partial) } : {}), hidden: [...unseen.values()] } : {}),
        ...(view?.trim() ? { view: view.trim().slice(0, 400) } : {}),
        ...(frame?.trim() ? { frame: frame.trim().slice(0, 1600) } : {}),
        ...(endFrame?.trim() ? { endFrame: endFrame.trim().slice(0, 1600) } : {}),
        ...(placeView(background) ? { background: placeView(background) } : {}),
        // Lines that run over the shot are cut off mid-word, or spill over the next shot: the shot is made as long as
        // they need, as far as one clip goes.
        durationSeconds: Math.max(asked, Math.min(15, limits.maxSeconds, secondsForLines(dialogue.map((d) => d.text)))),
        prompt: s.prompt.trim().slice(0, 2400),
        dialogue,
      }
    })
  if (!cleaned.length) throw new ApiError(502, 'The Director returned no usable shots')
  // Shot by shot (LTX): whatever groups the reply numbered, every shot is a clip of its own.
  if (opts.separate) return cleaned.map((s) => ({ ...s, group: 0 }))
  // With LTX a shot where someone speaks is rendered on its own (see soloDialogueFor): it leaves its group first.
  const groups = splitGroups(soloEndFrameShots(opts.soloDialogue ? soloSpeakingShots(cleaned) : cleaned), limits)
  return cleaned.map((s, i) => ({ ...s, group: groups[i]! }))
}

/**
 * Clamps durations, trims text and drops empty shots — the schema only guarantees shape. Multi-shot groups are cut to
 * what one clip of the target model takes (`limits`, its workflow's multishot; default LTX-2.5's 3 shots in 10 s, as
 * on RunPod — local LTX takes 2 in 8 s): an oversized group becomes several, and a shot left over plays on its own
 * (group 0).
 */
export function sanitizeBreakdown(
  b: Breakdown,
  limits: Pick<VideoMultishot, 'maxShots' | 'maxSeconds'> = workflowFor(undefined).multishot,
  opts: { soloDialogue?: boolean; separate?: boolean } = {},
): Breakdown {
  const shots = sanitizeShots(b.shots, limits, opts)
  const places = (b.places ?? []).filter((p) => p.name.trim())
  const known = new Set(places.map((p) => p.name.toLowerCase()))
  // A shot pointing at a place the list doesn't have would link to nothing.
  return { ...b, places, shots: shots.map((s) => ({ ...s, place: s.place && known.has(s.place.toLowerCase()) ? s.place : '' })) }
}

/** Structured answer from the chosen text model (Settings → AI Director); see services/llm.ts for the routes. */
export const structuredCall = <T>(
  creds: DirectorCredentials,
  system: string,
  user: string,
  schema: z.ZodType<T>,
  shape: string,
  effort: 'low' | 'medium' | 'high' = 'medium',
) => llmStructured(creds, { system, user, schema, shape, effort })

const BREAKDOWN_SHAPE = `{"title": string, "characters": [{"name": string, "description": string, "voice": string}], "places": [{"name": string, "description": string, "blocking": string, "light": string}], "shots": [{"scene": string, "place": string, "description": string, "shotType": string, "camera": string, "prompt": string, "durationSeconds": number, "characters": [string], "partial": [string], "dialogue": [{"character": string, "text": string}], "sfx": string, "group": number}]}`

/**
 * A script passage read by demo rules: `NAME: line` is dialogue (names kept as `names` has them, new ones added in
 * title case), everything else is action.
 */
function readPassage(text: string, names: Map<string, string>): { dialogue: { character: string; text: string }[]; action: string[] } {
  const dialogue: { character: string; text: string }[] = []
  const action: string[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*([A-ZĄĆĘŁŃÓŚŹŻ][\wĄĆĘŁŃÓŚŹŻąćęłńóśźż .'-]{0,30}):\s*(.+)$/.exec(line)
    if (m) {
      const name = m[1]!.trim()
      const key = name.toUpperCase()
      if (!names.has(key)) names.set(key, name.charAt(0) + name.slice(1).toLowerCase())
      dialogue.push({ character: names.get(key)!, text: m[2]!.trim() })
    } else if (line.trim()) action.push(line.trim())
  }
  return { dialogue, action }
}

/** Offline fallback for demo mode: paragraphs become shots, `NAME: line` becomes dialogue. */
export function demoBreakdown(req: BreakdownRequest): Breakdown {
  const paragraphs = req.script
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
  const names = new Map<string, string>()
  for (const c of req.characters ?? []) names.set(c.name.toUpperCase(), c.name)
  const shots = paragraphs.map((p, i) => {
    const { dialogue, action } = readPassage(p, names)
    const description = action.join(' ') || dialogue.map((d) => `${d.character} speaks`).join(', ')
    const style = req.style?.trim() ? `, ${req.style.trim()}` : ''
    return {
      scene: `Scene ${i + 1}`,
      place: '',
      description: description.slice(0, 140),
      shotType: dialogue.length ? 'MEDIUM' : 'WIDE',
      camera: 'slow push in',
      prompt: `${description}${style}, cinematic lighting`,
      durationSeconds: Math.min(10, Math.max(3, Math.round(description.length / 30) + dialogue.length * 2 + 3)),
      characters: [...new Set(dialogue.map((d) => d.character))],
      partial: [],
      group: 0,
      dialogue,
      sfx: '',
    }
  })
  return {
    title: 'Untitled',
    characters: [...names.values()].map((name) => {
      const known = req.characters?.find((c) => c.name === name)
      return { name, description: known?.description ?? '', ...(known?.voice ? { voice: known.voice } : {}) }
    }),
    places: req.places ?? [],
    shots: shots.length ? shots : [{ scene: 'Scene 1', place: '', description: 'Opening shot', shotType: 'WIDE', camera: 'static', prompt: 'Establishing shot', durationSeconds: 5, characters: [], partial: [], dialogue: [], sfx: '', group: 0 }],
  }
}

/**
 * Script → shots, written for the target video model (`req.targetModelId`; unknown or missing: LTX-2.5) and kept
 * within its multi-shot limits. `call` is injectable for tests.
 */
export async function breakdownScript(
  req: BreakdownRequest,
  creds: DirectorCredentials,
  demoMode: boolean,
  call: typeof structuredCall = structuredCall,
): Promise<BreakdownResponse> {
  if (!req.script?.trim()) throw new ApiError(400, 'Write a script or idea first')
  const target = breakdownTarget(req.targetModelId)
  const limits = workflowFor(target).multishot
  const opts = { soloDialogue: soloDialogueFor(target), separate: rendersSeparately(target, true) }
  if (creds.anthropic || creds.openrouter || creds.fal) {
    const { result, via, model } = await call(creds, breakdownSystem(target), userPrompt(req), breakdownSchema, BREAKDOWN_SHAPE)
    return { breakdown: sanitizeBreakdown(result, limits, opts), via, model }
  }
  if (demoMode) return { breakdown: sanitizeBreakdown(demoBreakdown(req), limits, opts), via: 'demo', model: 'local rules' }
  throw new ApiError(400, 'The AI Director needs an Anthropic, OpenRouter or fal.ai key (Settings → Providers)')
}

// ---- two passes: the outline (the world and the structure), then each scene's shots

const outlineSchema = z.object({
  title: z.string(),
  logline: z.string(),
  characters: z.array(z.object({ name: z.string(), description: z.string(), voice: z.string() })),
  places: z.array(z.object({ name: z.string(), description: z.string(), blocking: z.string(), light: z.string() })),
  chapters: z.array(
    z.object({
      title: z.string(),
      summary: z.string(),
      scenes: z.array(
        z.object({
          heading: z.string(),
          place: z.string(),
          time: z.string(),
          light: z.string(),
          blocking: z.string(),
          characters: z.array(z.string()),
          summary: z.string(),
          opening: z.string(),
          seconds: z.number(),
          continuesPrevious: z.boolean(),
        }),
      ),
    }),
  ),
})
export type RawOutline = z.infer<typeof outlineSchema>

const OUTLINE_SHAPE = `{"title": string, "logline": string, "characters": [{"name": string, "description": string, "voice": string}], "places": [{"name": string, "description": string, "blocking": string, "light": string}], "chapters": [{"title": string, "summary": string, "scenes": [{"heading": string, "place": string, "time": string, "light": string, "blocking": string, "characters": [string], "summary": string, "opening": string, "seconds": number, "continuesPrevious": boolean}]}]}`

const sceneShotsSchema = z.object({
  shots: z.array(
    breakdownSchema.shape.shots.element
      .omit({ scene: true, place: true })
      .extend({ view: z.string(), frame: z.string(), endFrame: z.string(), background: z.string(), hidden: z.array(z.string()) }),
  ),
})

const SCENE_SHOTS_SHAPE = `{"shots": [{"description": string, "shotType": string, "view": string, "frame": string, "endFrame": string, "background": "main" | "reverse" | "left" | "right", "camera": string, "prompt": string, "durationSeconds": number, "characters": [string], "partial": [string], "hidden": [string], "dialogue": [{"character": string, "text": string}], "sfx": string, "group": number}]}`

/** A screenplay scene heading line: INT. / EXT. / INT./EXT. / I/E. and the rest (the place and time). */
const SCENE_HEADING = /^\s*(?:INT\.?\s*\/\s*EXT\.?|EXT\.?\s*\/\s*INT\.?|I\/E\.?|INT\.|EXT\.)\s*(.+)$/i
/**
 * A Polish one: WN. or WEW. (inside), PL. or ZEW. (outside), WN./PL. — in capitals only, as headings are written:
 * "Pl." also opens an address ("Pl. Zbawiciela"), and "WN. SALON — DZIEŃ" used to stay at the end of the scene before.
 */
const SCENE_HEADING_PL = /^\s*(?:(?:WN|WEW)\.?\s*\/\s*(?:PL|ZEW)\.?|(?:PL|ZEW)\.?\s*\/\s*(?:WN|WEW)\.?|WN\.|WEW\.|PL\.|ZEW\.)\s*(.+)$/
const sceneHeading = (line: string) => SCENE_HEADING.exec(line) ?? SCENE_HEADING_PL.exec(line)

/** Lower case, one space between words, plain quotes and dashes — with where each character came from in `text`. */
function searchable(text: string): { text: string; at: number[] } {
  let out = ''
  const at: number[] = []
  for (let i = 0; i < text.length; i++) {
    let ch = text[i]!
    if (/\s/.test(ch)) {
      if (!out || out.endsWith(' ')) continue
      ch = ' '
    } else {
      ch = ch.toLowerCase().replace(/[‘’‚‛]/g, "'").replace(/[“”„‟]/g, '"').replace(/[–—]/g, '-')
    }
    out += ch
    at.push(i)
  }
  return { text: out, at }
}

/**
 * The script cut into the scenes' parts at their opening words, found in order (spacing, case and curly quotes don't
 * matter): the script stays exactly as written, and the model needn't copy it out. Whatever comes before the second
 * scene belongs to the first; a scene whose opening isn't found gets no part — its text stays with the scene before.
 */
export function sliceScript(script: string, openings: readonly string[]): string[] {
  const hay = searchable(script)
  const starts: (number | undefined)[] = []
  let from = 0
  openings.forEach((opening, k) => {
    const words = searchable(opening).text.trim().split(' ')
    // The whole opening, else its first five words (a model may stray from the script further in).
    const found = [words.join(' '), words.slice(0, 5).join(' ')]
      .filter((needle) => needle.length >= 8)
      .map((needle) => hay.text.indexOf(needle, from))
      .find((i) => i >= 0)
    // The first scene starts the script, but the search goes on past its opening: scene 2 under the same heading
    // ("INT. KITCHEN — NIGHT" twice) found its five words in scene 1's, and took scene 1's text with its own.
    if (k === 0) {
      from = (found ?? 0) + 1
      return void starts.push(0)
    }
    if (found === undefined) return void starts.push(undefined)
    from = found + 1
    // An opening copied from below its scene heading ("One warm bulb…" under "INT. KITCHEN — NIGHT"): the heading
    // belongs to this scene, not the end of the one before.
    let start = hay.at[found]!
    const before = script.slice(0, start).replace(/\s+$/, '')
    const lineStart = before.lastIndexOf('\n') + 1
    if (sceneHeading(before.slice(lineStart)) && lineStart > (starts.at(-1) ?? -1)) start = lineStart
    starts.push(start)
  })
  return starts.map((start, k) => {
    if (start === undefined) return ''
    const end = starts.slice(k + 1).find((s): s is number => s !== undefined) ?? script.length
    return script.slice(start, end).trim()
  })
}

const placeWords = (text: string) => new Set(text.toLowerCase().match(/\p{L}{4,}/gu) ?? [])

/**
 * The place a scene's "place" names: the one with that name; else one whose name holds it or is held in it; else the
 * one sharing the most words with it in its name and look ("Wooden Pier" → "Misty Lakeshore", whose look has "a small
 * weathered wooden pier"); else a new place by that name. A scene left without one got no photo, look or blocking —
 * its shots and keyframes made up a new place.
 */
export function placeFor(name: string, places: Outline['places']): { place: string; added?: Outline['places'][number] } {
  const wanted = name.trim()
  if (!wanted) return { place: '' }
  const lower = wanted.toLowerCase()
  const named = places.find((p) => p.name.toLowerCase() === lower) ?? places.find((p) => p.name.toLowerCase().includes(lower) || lower.includes(p.name.toLowerCase()))
  if (named) return { place: named.name }
  const words = placeWords(wanted)
  let best: { name: string; shared: number } | undefined
  for (const p of places) {
    const theirs = placeWords(`${p.name} ${p.description}`)
    const shared = [...words].filter((w) => theirs.has(w)).length
    if (shared && shared > (best?.shared ?? 0)) best = { name: p.name, shared }
  }
  if (best) return { place: best.name }
  return { place: wanted, added: { name: wanted, description: '' } }
}

/**
 * The schema only guarantees shape: names trimmed, empty chapters and scenes dropped, cast in scenes only when the
 * outline has them, every scene's place found (placeFor), lengths clamped, and the script cut into the scenes' parts
 * (sliceScript).
 */
export function sanitizeOutline(o: RawOutline, script: string): Outline {
  const characters = o.characters
    .filter((c) => c.name.trim())
    .map((c) => ({ name: c.name.trim(), description: c.description.trim(), ...(c.voice.trim() ? { voice: c.voice.trim() } : {}) }))
  const places = o.places
    .filter((p) => p.name.trim())
    .map((p) => ({
      name: p.name.trim(),
      description: p.description.trim(),
      ...(p.blocking.trim() ? { blocking: p.blocking.trim() } : {}),
      ...(p.light.trim() ? { light: p.light.trim() } : {}),
    }))
  const castNames = new Map(characters.map((c) => [c.name.toLowerCase(), c.name]))
  const placeOf = (name: string) => {
    const { place, added } = placeFor(name, places)
    if (added) places.push(added)
    return place
  }
  const chapters = o.chapters
    .map((c) => ({ ...c, scenes: c.scenes.filter((s) => s.heading.trim() || s.summary.trim()).slice(0, 40) }))
    .filter((c) => c.scenes.length)
    .slice(0, 12)
  const all = chapters.flatMap((c) => c.scenes)
  if (!all.length) throw new ApiError(502, 'The Director returned no scenes')
  const parts = sliceScript(script, all.map((s) => s.opening))
  let k = 0
  const sceneChapters = chapters.map((c, ci) => ({
      title: c.title.trim() || `Chapter ${ci + 1}`,
      summary: c.summary.trim(),
      scenes: c.scenes.map((s) => {
        const first = k === 0
        const part = parts[k++]!
        return {
          heading: s.heading.trim() || s.summary.trim().slice(0, 60),
          place: placeOf(s.place),
          time: s.time.trim(),
          light: s.light.trim(),
          blocking: s.blocking.trim(),
          characters: [...new Set(s.characters.map((n) => castNames.get(n.trim().toLowerCase())).filter((n): n is string => Boolean(n)))],
          summary: s.summary.trim(),
          script: part,
          seconds: Math.min(900, Math.max(3, Math.round(Number(s.seconds) || 30))),
          continuesPrevious: !first && Boolean(s.continuesPrevious),
        }
      }),
    }))
  // A place no scene is set in only adds a second card for a location the scenes already have under another name
  // ("Mountain hut common room" beside the "Mountain Hut" every scene used): only the places the scenes use come back.
  // The project's own places are untouched either way — they are merged by name on the client.
  const used = new Set(sceneChapters.flatMap((c) => c.scenes.map((s) => s.place.toLowerCase())).filter(Boolean))
  return {
    title: o.title.trim() || 'Untitled',
    logline: o.logline.trim(),
    characters,
    places: places.filter((p) => used.has(p.name.toLowerCase())),
    chapters: sceneChapters,
  }
}

const titleWords = (text: string) => text.toLowerCase().replace(/(^|[\s(-])(\p{L})/gu, (_, before: string, ch: string) => before + ch.toUpperCase())

/**
 * Offline fallback for demo mode: INT./EXT. headings start scenes (else paragraphs do), the heading's place becomes a
 * place and its time the scene's, `NAME: line` names the cast. One chapter.
 */
export function demoOutline(req: OutlineRequest): RawOutline {
  const lines = req.script.split('\n')
  const chunks: { heading?: string; lines: string[] }[] = []
  if (lines.some((l) => sceneHeading(l))) {
    for (const line of lines) {
      const m = sceneHeading(line)
      if (m) chunks.push({ heading: m[1]!.trim(), lines: [line] })
      else if (chunks.length) chunks.at(-1)!.lines.push(line)
      else chunks.push({ lines: [line] })
    }
  } else {
    for (const p of req.script.split(/\n\s*\n/)) chunks.push({ lines: p.split('\n') })
  }
  const names = new Map<string, string>()
  for (const c of req.characters ?? []) names.set(c.name.toUpperCase(), c.name)
  const places = new Map<string, { name: string; description: string; blocking: string; light: string }>()
  for (const p of req.places ?? []) places.set(p.name.toLowerCase(), { name: p.name, description: p.description, blocking: p.blocking ?? '', light: p.light ?? '' })
  const scenes = chunks
    .map((c) => ({ ...c, text: c.lines.join('\n').trim() }))
    .filter((c) => c.text)
    .map((c, i) => {
      const { dialogue, action } = readPassage(c.lines.filter((l) => !sceneHeading(l)).join('\n'), names)
      const [where = '', when = ''] = (c.heading ?? '').split(/\s+[-–—]+\s+/)
      const place = where ? titleWords(where.trim()) : ''
      if (place && !places.has(place.toLowerCase())) places.set(place.toLowerCase(), { name: place, description: '', blocking: '', light: '' })
      const speaking = [...new Set(dialogue.map((d) => d.character))]
      return {
        heading: c.heading ? titleWords(c.heading) : `Scene ${i + 1}`,
        place,
        time: when.trim().toLowerCase(),
        light: '',
        blocking: '',
        characters: speaking,
        summary: (action.join(' ') || speaking.map((n) => `${n} speaks`).join(', ')).slice(0, 160),
        opening: c.text.split(/\s+/).slice(0, 10).join(' '),
        seconds: Math.max(5, Math.round(c.text.length / 12)),
        continuesPrevious: false,
      }
    })
  return {
    title: 'Untitled',
    logline: '',
    characters: [...names.values()].map((name) => {
      const known = req.characters?.find((c) => c.name === name)
      return { name, description: known?.description ?? '', voice: known?.voice ?? '' }
    }),
    places: [...places.values()],
    chapters: [{ title: 'Chapter 1', summary: '', scenes }],
  }
}

/**
 * Pass one: script → cast, places, chapters and scenes (each with its part of the script), no shots. The cast and
 * places sent along keep their names and looks. `call` is injectable for tests.
 */
export async function outlineScript(
  req: OutlineRequest,
  creds: DirectorCredentials,
  demoMode: boolean,
  call: typeof structuredCall = structuredCall,
): Promise<OutlineResponse> {
  if (!req.script?.trim()) throw new ApiError(400, 'Write a script or idea first')
  if (creds.anthropic || creds.openrouter || creds.fal) {
    const { result, via, model } = await call(creds, outlineSystem(), userPrompt(req), outlineSchema, OUTLINE_SHAPE)
    return { outline: sanitizeOutline(result, req.script), via, model }
  }
  if (demoMode) return { outline: sanitizeOutline(demoOutline(req), req.script), via: 'demo', model: 'local rules' }
  throw new ApiError(400, 'The AI Director needs an Anthropic, OpenRouter or fal.ai key (Settings → Providers)')
}

const sentence = (text: string | undefined) => text?.trim().replace(/[.\s]+$/, '')

/** Pass two's user prompt: the scene, its place and cast as set, the scenes around it, and its part of the script. */
export function sceneShotsUserPrompt(req: SceneShotsRequest): string {
  const { scene, place, previous, next } = req
  const parts = [`Scene: ${scene.heading}${scene.time?.trim() ? ` (${scene.time.trim()})` : ''}`]
  if (scene.summary?.trim()) parts.push(`What happens: ${scene.summary.trim()}`)
  if (place) {
    const about = [
      `Place: ${place.name}${place.description.trim() ? ` — ${sentence(place.description)}` : ''}.`,
      place.photos?.length && `Its reference photos show: ${place.photos.map(sentence).join('; ')}. The main photo is the establishing view.`,
      place.views?.length && `It has a photo of ${place.views.length === 1 ? 'only its main view' : `these views: ${place.views.join(', ')}`} — the others are made once the shots ask for them.`,
    ]
    parts.push(about.filter(Boolean).join(' '))
  }
  const blocking = scene.blocking?.trim() || place?.blocking?.trim()
  if (blocking) parts.push(`Blocking at the start of the scene, seen from the establishing camera: ${blocking}`)
  const light = scene.light?.trim() || place?.light?.trim()
  if (light) parts.push(`Light: ${light}`)
  if (req.characters.length) {
    parts.push(`Cast — use these exact names; their looks are already set:\n${req.characters.map((c) => `- ${c.name}: ${c.description}${c.voice ? ` Voice: ${c.voice}` : ''}`).join('\n')}`)
  }
  if (previous) {
    const end = previous.lastShot && ` It ends on: ${previous.lastShot.shotType ? `${previous.lastShot.shotType} — ` : ''}${sentence(previous.lastShot.description) || sentence(previous.lastShot.prompt)}.`
    parts.push(`The scene before: ${previous.heading}${previous.summary ? ` — ${sentence(previous.summary)}` : ''}.${end ?? ''}${previous.samePlace ? ' It is set in the same place.' : ''}`)
  }
  if (scene.continuesPrevious) parts.push('This scene continues straight on from the previous one, with no jump in time: its first shot picks up from the previous scene’s last shot.')
  if (next) parts.push(`The scene after: ${next.heading}${next.summary ? ` — ${sentence(next.summary)}` : ''}.`)
  if (req.style?.trim()) parts.push(`Visual style: ${req.style.trim()}`)
  if (req.aspect) parts.push(`Aspect ratio: ${req.aspect}`)
  if (req.targetShots) parts.push(`Aim for about ${req.targetShots} shots.`)
  parts.push(`This scene's part of the script:\n"""\n${req.script.trim()}\n"""`)
  return parts.join('\n\n')
}

/**
 * Pass two: one scene's shots, written for the target video model (as breakdownScript) from the scene's part of the
 * script (else its summary), with its heading and place filled in. `call` is injectable for tests.
 */
export async function writeSceneShots(
  req: SceneShotsRequest,
  creds: DirectorCredentials,
  demoMode: boolean,
  call: typeof structuredCall = structuredCall,
): Promise<SceneShotsResponse> {
  const script = req.script?.trim() || req.scene?.summary?.trim()
  if (!req.scene?.heading?.trim() || !script) throw new ApiError(400, 'This scene has no script or summary to write shots from')
  const target = breakdownTarget(req.targetModelId)
  const limits = workflowFor(target).multishot
  const opts = { soloDialogue: soloDialogueFor(target), separate: rendersSeparately(target, true) }
  const finish = (shots: readonly Omit<RawShot, 'scene' | 'place'>[]) =>
    sanitizeShots(
      shots.map((s) => ({ ...s, scene: req.scene.heading, place: req.place?.name ?? '' })),
      limits,
      opts,
    )
  if (creds.anthropic || creds.openrouter || creds.fal) {
    const { result, via, model } = await call(creds, sceneShotsSystem(target), sceneShotsUserPrompt({ ...req, script }), sceneShotsSchema, SCENE_SHOTS_SHAPE)
    return { shots: finish(result.shots), via, model }
  }
  if (demoMode) {
    const shots = demoBreakdown({ script, style: req.style, characters: req.characters }).shots
    // The scene opens on its establishing wide.
    return { shots: finish(shots.map((s, i) => (i === 0 ? { ...s, shotType: 'WIDE' } : s))), via: 'demo', model: 'local rules' }
  }
  throw new ApiError(400, 'The AI Director needs an Anthropic, OpenRouter or fal.ai key (Settings → Providers)')
}

// ---- the look of a hero or a place (the designer's "Improve with AI"), and a script from an idea

const lookSchema = z.object({ description: z.string() })

/** How a hero's or a place's look is written: the form the breakdown and the keyframes read it in. */
export function improveLookSystem(kind: 'character' | 'place'): string {
  if (kind === 'character') {
    return `You write the look of one character of a short film for an AI image model that will draw them, and draw them the same in every shot.
Return "description": one paragraph in the form "Name, age, build, face and hair; clothing and distinguishing features". The first clause (up to the first ";", under 90 characters) says who they are with their face and hair. Be concrete and visual: age, build, skin, face, eyes, hair colour, length and style; then the clothes with colours and materials, shoes, and one or two distinguishing details. Keep everything the user wrote unless it contradicts itself, and fill the gaps plausibly for the story, its time and its place. No personality, backstory, camera, light or text in the picture. Write in English.`
  }
  return `You write the look of one location of a short film for an AI image model that will draw it, and draw it the same in every shot there.
Return "description": one paragraph — what it looks like (architecture, materials, surroundings, the vehicles and objects that belong there) and its geography: what lies on each side of where the action happens ("north of the road: an open field with hay bales; south, behind the parked cars: tall grass and a row of birches"), so a reverse shot can show the opposite side. Keep everything the user wrote unless it contradicts itself, and fill the gaps plausibly for the story. No people, no camera, no light (set separately), no text in the picture. Write in English.`
}

export async function improveLook(
  req: ImproveLookRequest,
  creds: DirectorCredentials,
  demoMode: boolean,
  call: typeof structuredCall = structuredCall,
): Promise<ImproveLookResponse> {
  if (!req.name?.trim() && !req.description?.trim()) throw new ApiError(400, 'Give it a name or a few words first')
  if (creds.anthropic || creds.openrouter || creds.fal) {
    const user = [
      `${req.kind === 'character' ? 'Character' : 'Location'}: ${req.name?.trim() || '(no name yet)'}`,
      `What the user wrote: ${req.description?.trim() || '(nothing yet)'}`,
      req.style?.trim() && `Visual style of the film: ${req.style.trim()}`,
      req.script?.trim() && `The story, for context:\n"""\n${req.script.trim().slice(0, 4000)}\n"""`,
    ]
      .filter(Boolean)
      .join('\n\n')
    const { result, via, model } = await call(creds, improveLookSystem(req.kind), user, lookSchema, '{"description": string}')
    return { description: result.description.trim(), via, model }
  }
  if (demoMode) return { description: req.description?.trim() || `${req.name?.trim()}`, via: 'demo', model: 'local rules' }
  throw new ApiError(400, 'The AI Director needs an Anthropic, OpenRouter or fal.ai key (Settings → Providers)')
}

/** How each of a place's other directions is turned from its main view. */
const TURNS: Record<PlaceViewRequest['view'], string> = {
  reverse: 'turned all the way round (180°), facing back toward where the main view\'s camera stands',
  left: 'turned 90° to the left of the main view',
  right: 'turned 90° to the right of the main view',
}

/**
 * One of a place's other directions written out for the image model. Told only to turn the camera, GPT Image 2.5 and
 * FLUX 3 both redrew the main view — its layout, repeated in the description, held them to it (By the Lake, left).
 */
export function placeViewSystem(view: PlaceViewRequest['view']): string {
  return `You describe one view of a film location for an AI image model. You get the location's look and its geography as seen from its main (establishing) view. Write what a camera standing at the same spot and height sees when ${TURNS[view]}.
Return "description": one paragraph — what fills this frame from the foreground to the background and from the left edge to the right, using only what the geography puts in this direction. Things in the middle of the main view are now at the edge of this frame or out of sight: say where, if they show at all. Say from which side of this frame the light falls. Keep the materials, plants, weather and time of day. No people, no camera talk, no text in the picture. Write in English.`
}

const viewSchema = z.object({ description: z.string() })

/** What the place looks like `req.view`, for the look designer's angle (offline: the turn and the look, as given). */
export async function writePlaceView(
  req: PlaceViewRequest,
  creds: DirectorCredentials,
  demoMode: boolean,
  call: typeof structuredCall = structuredCall,
): Promise<PlaceViewResponse> {
  if (!req.description?.trim()) throw new ApiError(400, 'Describe the place first')
  if (!TURNS[req.view]) throw new ApiError(400, 'Pick the reverse, left or right view')
  if (creds.anthropic || creds.openrouter || creds.fal) {
    const user = [
      `Location: ${req.name?.trim() || '(no name)'}`,
      `Its look and geography, from the main view: ${req.description.trim()}`,
      req.light?.trim() && `Light: ${req.light.trim()}`,
      req.style?.trim() && `Visual style of the film: ${req.style.trim()}`,
    ]
      .filter(Boolean)
      .join('\n\n')
    const { result, via, model } = await call(creds, placeViewSystem(req.view), user, viewSchema, '{"description": string}', 'low')
    return { description: result.description.trim(), via, model }
  }
  if (demoMode) return { description: `${req.name.trim()}, ${TURNS[req.view]}.`, via: 'demo', model: 'local rules' }
  throw new ApiError(400, 'The AI Director needs an Anthropic, OpenRouter or fal.ai key (Settings → Providers)')
}

const scriptSchema = z.object({ title: z.string(), script: z.string() })

/** An idea → a short screenplay the outline can read: headings, action, NAME: lines, staged so it can be filmed. */
export function writeScriptSystem(): string {
  return `You are a screenwriter. Turn the user's idea into a short screenplay for a film made with AI video models.
Format: each scene starts with a heading on its own line ("EXT. ROADSIDE PAST A BIRCH FOREST — DUSK"); action in the present tense, in short paragraphs; dialogue as "NAME: line", with an acting cue in square brackets where it helps ("JAN: [quietly] Look. Smoke."). Introduce each character with a short look the first time they appear (age, build, hair, clothes).
Length: 3 to 6 scenes, about one to three minutes on screen, unless the idea asks for something else.
Language: the dialogue in the language of the idea (a Polish idea gets Polish dialogue); headings and action in English.
Stage it so it can be filmed: few people per scene; people talk standing or sitting where the camera sees their faces — never through a car window or inside a moving car; one clear action at a time; places that stay the same within a scene.
Write what the camera needs, in the action lines: when the story first comes to a place, its layout — what is on each side of where the action happens (the water ahead, reeds to one side, the path behind); where each person is in it and which way they face, turning toward each other when they talk; and who holds which prop, until it is handed over or put down.
Return "title" (the film's title) and "script" (the screenplay).`
}

export async function writeScript(
  req: WriteScriptRequest,
  creds: DirectorCredentials,
  demoMode: boolean,
  call: typeof structuredCall = structuredCall,
): Promise<WriteScriptResponse> {
  if (!req.idea?.trim()) throw new ApiError(400, 'Write an idea first')
  if (creds.anthropic || creds.openrouter || creds.fal) {
    const user = [`Idea: ${req.idea.trim()}`, req.style?.trim() && `Visual style: ${req.style.trim()}`, req.aspect && `Aspect ratio: ${req.aspect}`].filter(Boolean).join('\n\n')
    const { result, via, model } = await call(creds, writeScriptSystem(), user, scriptSchema, '{"title": string, "script": string}', 'high')
    return { title: result.title.trim(), script: result.script.trim(), via, model }
  }
  if (demoMode) return { title: 'Untitled', script: `EXT. SOMEWHERE — DAY\n${req.idea.trim()}`, via: 'demo', model: 'local rules' }
  throw new ApiError(400, 'The AI Director needs an Anthropic, OpenRouter or fal.ai key (Settings → Providers)')
}

const ENHANCE_SYSTEM = `You rewrite prompts for AI image and video generators. Keep the user's intent, subject and any names; add concrete visual detail: subject and action, setting, lighting, lens/framing and (for video) one clear camera movement. One paragraph, no lists, no dialogue, under 90 words.`

/** For music, sound effects and foley: a sound, not a picture. */
const ENHANCE_AUDIO_SYSTEM = `You rewrite prompts for AI audio generators (music, sound effects, foley). Keep the user's intent and any names; never add visuals, camera or lighting, and never add lyrics or speech unless the user wrote them.
- Music: genre and subgenre, mood, tempo (BPM), key instruments and their roles, arrangement and how it develops, production and mix character, and what it is for (a trailer, a background bed under voice, a loop).
- Sound effects: the source and the action, the material and size, the space (dry, small room, hall, outdoors) and distance, how it starts, evolves and ends, and its length or rhythm.
- Foley for a video: the sounds the scene's actions make, in order, with their surfaces, materials and intensity, and the ambience under them.
One paragraph, no lists, under 70 words.`

const AUDIO_KINDS = new Set<EnhanceRequest['kind']>(['music', 'sfx', 'foley'])

/** With the pictures that go to the generator: a prompt that fits them, changing only what the user asks. */
const ENHANCE_PICTURES = `You also see the pictures that go to the generator with this prompt, each labelled with its role and how the prompt names it. The rewritten prompt must fit them:
- A reference, or the image being edited: name it as labelled and say what to keep from it — the place, people, objects, light, time of day, weather, colours and style you see. Change only what the user's prompt asks to change (a turned camera, a new action, a removed object). Never describe a light, time of day, season or setting that contradicts the picture unless the user asks for that change.
- When the user turns the camera, it is the same place as the picture seen from the new direction: describe what that side plausibly shows, in the picture's light and style.
- A start frame: the shot begins on it — write what happens from there (action, camera), not a description of the picture.
- An end frame: the shot ends on it — write how it gets there.
Up to 120 words when there are pictures.`

const ROLE_TEXT: Record<EnhanceReference['role'], string> = {
  start: 'the start frame (the shot begins on it)',
  end: 'the end frame (the shot ends on it)',
  reference: 'a reference picture to follow',
  input: 'the image being edited',
}

/** What the Director reads: the target and the prompt, after each picture labelled by its role and its name. */
export function enhanceContent(input: EnhanceRequest, pictures: { ref: EnhanceReference; jpeg: Buffer }[]): LlmContent {
  const kind = { sfx: 'sound effect', foley: 'video-to-foley' }[input.kind as string] ?? input.kind
  const style = input.style && !AUDIO_KINDS.has(input.kind) ? ` Visual style: ${input.style}.` : ''
  const article = /^[aeiou]/.test(kind) ? 'an' : 'a'
  const target = `Target: ${input.model ? `${input.model}, ` : ''}${article} ${kind} model.${style}`
  const user = `${target}\nPrompt: ${input.prompt.trim()}`
  if (!pictures.length) return user
  const parts: LlmPart[] = []
  pictures.forEach(({ ref, jpeg: data }, i) => {
    parts.push({ type: 'text', text: `Picture ${i + 1} — ${ROLE_TEXT[ref.role]}; the prompt names it "${ref.token}":` })
    parts.push(jpeg(data))
  })
  parts.push({ type: 'text', text: user })
  return parts
}

export async function enhancePrompt(
  input: EnhanceRequest,
  creds: DirectorCredentials,
  pictures: { ref: EnhanceReference; jpeg: Buffer }[] = [],
): Promise<{ prompt: string; via: string; model: string }> {
  // Sounds take no pictures: only the prompt goes.
  const audio = AUDIO_KINDS.has(input.kind)
  const user = enhanceContent(input, audio ? [] : pictures)
  const { result, via, model } =
    typeof user === 'string'
      ? await structuredCall(creds, audio ? ENHANCE_AUDIO_SYSTEM : ENHANCE_SYSTEM, user, promptSchema, '{"prompt": string}')
      : await llmStructured(creds, { system: `${ENHANCE_SYSTEM}\n${ENHANCE_PICTURES}`, user, schema: promptSchema, shape: '{"prompt": string}', vision: true })
  return { prompt: result.prompt, via, model }
}

// ---------------------------------------------------------------------------------------------------------------
// Dialogue length: shorten lines so they can be spoken within the shot

const trimSchema = z.object({ lines: z.array(z.string()) })

const TRIM_SYSTEM = `You are a dialogue editor tightening lines of a short film so they can be spoken within the shot.
Rules:
- Return exactly as many lines as you are given, in the same order: one shortened line per numbered input line. Never add, merge, split or drop lines.
- Keep each line's leading audio tag in square brackets (e.g. [whispering]) exactly as written, at the start of the line.
- Keep the meaning, the information the scene needs, and each speaker's voice and register.
- Keep the language of the lines; never translate.
- Stay within the total word budget (about ${WORDS_PER_SECOND} spoken words per second; audio tags don't count). Cut filler, repetition and hedging first, and shorten the longest lines most. A line that is already short may stay as it is.
- Return only the spoken text: no speaker names, no numbering.`

/** Words that can be spoken in `seconds`. */
export const wordBudget = (seconds: number) => Math.max(1, Math.floor(seconds * WORDS_PER_SECOND))

type DialogueLine = TrimDialogueRequest['lines'][number]

/**
 * The model's lines checked against the originals: undefined when the count is wrong or a line came back empty (the
 * caller asks again). Echoed numbering or speaker names are removed, and each line gets its original leading audio
 * tags back — exactly those, so delivery directions survive even when the model drops or invents one.
 */
export function fitTrimmedLines(originals: readonly DialogueLine[], out: readonly string[]): string[] | undefined {
  if (out.length !== originals.length) return undefined
  const lines: string[] = []
  for (const [i, original] of originals.entries()) {
    let text = String(out[i] ?? '').trim()
    if (!/^\d+[.)]\s/.test(original.text)) text = text.replace(/^\d+[.)]\s+/, '')
    const speaker = original.speaker.trim()
    if (speaker && text.toLowerCase().startsWith(`${speaker.toLowerCase()}:`)) text = text.slice(speaker.length + 1).trim()
    const body = withoutLeadingTags(text)
    if (!body) return undefined
    const tags = leadingTags(original.text)
    lines.push(tags ? `${tags} ${body}` : body)
  }
  return lines
}

/** Offline fallback for demo mode: the word budget shared out by line length, lines cut at a word boundary. */
export function demoTrim(lines: readonly DialogueLine[], maxSeconds: number): string[] {
  const words = lines.map((l) => speakableText(withoutLeadingTags(l.text)).split(' ').filter(Boolean))
  const total = words.reduce((n, w) => n + w.length, 0)
  const budget = wordBudget(maxSeconds)
  if (total <= budget) return lines.map((l) => l.text)
  return lines.map((l, i) => {
    const w = words[i]!
    const keep = Math.min(w.length, Math.max(2, Math.floor((w.length / total) * budget)))
    const body = keep < w.length ? `${w.slice(0, keep).join(' ').replace(/[,;:.!?…-]+$/, '')}…` : w.join(' ')
    const tags = leadingTags(l.text)
    return tags ? `${tags} ${body}` : body
  })
}

/**
 * Shortens dialogue to fit `maxSeconds`. Same number and order of lines, guaranteed: a wrong count is asked again
 * once, then fails with 502. Empty lines stay empty and are not sent. `call` is injectable for tests.
 */
export async function trimDialogue(
  req: TrimDialogueRequest,
  creds: DirectorCredentials,
  demoMode: boolean,
  call: typeof structuredCall = structuredCall,
): Promise<TrimDialogueResponse> {
  if (!Array.isArray(req.lines) || !req.lines.length) throw new ApiError(400, 'There are no lines to shorten')
  if (req.lines.length > 80) throw new ApiError(400, 'Shorten at most 80 lines at a time')
  const maxSeconds = Number(req.maxSeconds)
  if (!Number.isFinite(maxSeconds) || maxSeconds <= 0) throw new ApiError(400, 'maxSeconds must be a positive number')
  const all = req.lines.map((l) => ({
    speaker: typeof l?.speaker === 'string' ? l.speaker : '',
    text: typeof l?.text === 'string' ? l.text.trim() : '',
  }))
  const spoken = all.flatMap((l, i) => (speakableText(l.text) ? [i] : []))
  if (!spoken.length) throw new ApiError(400, 'There are no lines to shorten')
  const lines = spoken.map((i) => all[i]!)
  const merge = (out: string[]) => {
    const result = all.map((l) => l.text)
    spoken.forEach((at, k) => (result[at] = out[k]!))
    return result
  }

  if (!creds.anthropic && !creds.openrouter && !creds.fal) {
    if (demoMode) return { lines: merge(demoTrim(lines, maxSeconds)), via: 'demo', model: 'local rules' }
    throw new ApiError(400, 'The AI Director needs an Anthropic, OpenRouter or fal.ai key (Settings → Providers)')
  }

  const budget = wordBudget(maxSeconds)
  const total = lines.reduce((n, l) => n + countWords(l.text), 0)
  const user = [
    `Time limit: ${Math.round(maxSeconds * 10) / 10} s — at most ${budget} spoken words in total across all lines (now ${total}).`,
    req.language?.trim() ? `Language: ${req.language.trim()} (keep it).` : 'Keep each line in its own language.',
    `Lines (${lines.length}):`,
    ...lines.map((l, i) => `${i + 1}. ${l.speaker.trim() || 'Speaker'}: ${l.text}   (${countWords(l.text)} words)`),
    `Return exactly ${lines.length} lines in "lines", in this order.`,
  ].join('\n')

  let feedback = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const { result, via, model } = await call(creds, TRIM_SYSTEM, user + feedback, trimSchema, '{"lines": [string]}', 'low')
    const fitted = fitTrimmedLines(lines, result.lines)
    if (fitted) return { lines: merge(fitted), via, model }
    feedback = `\n\nYour previous answer had ${result.lines.length} lines (or an empty one). Return exactly ${lines.length} non-empty lines, one per numbered line above.`
  }
  throw new ApiError(502, 'The Director did not return one line per input line — try again')
}

// ---------------------------------------------------------------------------------------------------------------
// Vision: media descriptions, continuity review, subject framing (needs a model that reads images)

const jpeg = (data: Buffer): LlmPart => ({ type: 'image', jpeg: data })

/** A structured answer about frames: the chosen model if it reads images, else Claude Opus 5.5. */
async function visionCall<T>(creds: DirectorCredentials, system: string, content: LlmPart[], schema: z.ZodType<T>, shape: string, effort: 'low' | 'medium') {
  return (await llmStructured(creds, { system, user: content, schema, shape, effort, vision: true })).result
}

const describeSchema = z.object({
  description: z.string(),
  tags: z.array(z.string()),
})

const DESCRIBE_SYSTEM = `You catalogue footage for a video editor's media browser so it can be found by searching in plain language.
Given frames sampled from one clip (in time order), write "description": one or two plain sentences covering who/what is visible, the action, setting, time of day, shot size and camera movement, mood and dominant colours. Then "tags": 5–15 short lowercase search keywords (objects, people, places, actions, shot type, colours). Describe only what is visible; no guesses about identities.`

export async function describeMedia(frames: Buffer[], context: { name: string; prompt?: string }, creds: DirectorCredentials) {
  const hint = `Clip name: ${context.name}${context.prompt ? `\nGeneration prompt (may differ from the result): ${context.prompt}` : ''}`
  const out = await visionCall(creds, DESCRIBE_SYSTEM, [...frames.map(jpeg), { type: 'text', text: hint }], describeSchema, '{"description": string, "tags": [string]}', 'low')
  return { description: out.description.trim().slice(0, 600), tags: [...new Set(out.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 20) }
}

const continuitySchema = z.object({
  issues: z.array(
    z.object({
      cut: z.number(),
      severity: z.string(),
      category: z.string(),
      note: z.string(),
      fix: z.string(),
    }),
  ),
})

export interface ContinuityIssue {
  cut: number
  severity: 'low' | 'medium' | 'high'
  category: string
  note: string
  fix: string
}

const CONTINUITY_SYSTEM = `You are a script supervisor checking continuity between consecutive AI-generated shots of one film.
For each numbered cut you get the last frame of the outgoing shot and the first frame of the incoming shot, plus the incoming shot's prompt.
Report only real continuity breaks an audience would notice: a character's face, hair, age or wardrobe changing; props appearing or vanishing; lighting direction, time of day or weather jumping; colour grade mismatch; screen direction (180° rule) flips; a location that should be the same looking different.
Intentional changes (a new scene, a different location, a time jump) are not issues. Use the category words: character, wardrobe, props, lighting, color, direction, location, other. Severity: high = breaks the story, medium = clearly visible, low = minor.
"fix" is one sentence to append to the incoming shot's generation prompt so a re-generation matches (e.g. "The woman wears the same red wool coat with a black scarf as in the previous shot"). Return an empty list if every cut is fine.`

export async function reviewContinuity(
  cuts: { cut: number; outgoing: Buffer; incoming: Buffer; prompt?: string; label?: string }[],
  creds: DirectorCredentials,
): Promise<ContinuityIssue[]> {
  const content: LlmPart[] = []
  for (const c of cuts) {
    content.push({ type: 'text', text: `Cut ${c.cut}${c.label ? ` (${c.label})` : ''} — outgoing shot, last frame:` })
    content.push(jpeg(c.outgoing))
    content.push({ type: 'text', text: `Cut ${c.cut} — incoming shot, first frame. Prompt: ${c.prompt?.trim() || '(not generated / unknown)'}` })
    content.push(jpeg(c.incoming))
  }
  content.push({ type: 'text', text: 'Check every cut above.' })
  const out = await visionCall(
    creds,
    CONTINUITY_SYSTEM,
    content,
    continuitySchema,
    '{"issues": [{"cut": number, "severity": string, "category": string, "note": string, "fix": string}]}',
    'medium',
  )
  const valid = new Set(cuts.map((c) => c.cut))
  return out.issues
    .filter((i) => valid.has(i.cut) && i.note.trim())
    .map((i) => ({
      cut: i.cut,
      severity: (['low', 'medium', 'high'].includes(i.severity) ? i.severity : 'medium') as ContinuityIssue['severity'],
      category: i.category.trim().toLowerCase() || 'other',
      note: i.note.trim(),
      fix: i.fix.trim(),
    }))
}

const subjectSchema = z.object({
  frames: z.array(z.object({ index: z.number(), x: z.number(), y: z.number(), label: z.string() })),
})

const SUBJECT_SYSTEM = `You help reframe video for other aspect ratios. For each numbered frame, give the centre point of the main subject the audience should watch (a speaking or moving person's face, otherwise the most important object), as fractions of the frame width and height (0,0 = top-left, 1,1 = bottom-right). "label" names the subject in two or three words.`

/** Centre of attention per frame (0..1), for smart reframing. */
export async function locateSubjects(frames: Buffer[], creds: DirectorCredentials): Promise<{ x: number; y: number; label: string }[]> {
  const content: LlmPart[] = []
  frames.forEach((f, i) => {
    content.push({ type: 'text', text: `Frame ${i}:` })
    content.push(jpeg(f))
  })
  const out = await visionCall(creds, SUBJECT_SYSTEM, content, subjectSchema, '{"frames": [{"index": number, "x": number, "y": number, "label": string}]}', 'low')
  const clamp = (v: number) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0.5))
  return frames.map((_, i) => {
    const hit = out.frames.find((f) => f.index === i)
    return hit ? { x: clamp(hit.x), y: clamp(hit.y), label: hit.label } : { x: 0.5, y: 0.5, label: '' }
  })
}

// ------------------------------------------------------------------------------------------------ the Director's chat

/**
 * The plan as the model writes it: one flat shape for every step (structured outputs take a JSON-schema subset, no
 * unions), each field used by the steps that need it and empty otherwise — turned into typed steps by sanitizePlan.
 */
const rawPlanSchema = z.object({
  reply: z.string(),
  steps: z.array(
    z.object({
      op: z.string(),
      title: z.string(),
      sceneIds: z.array(z.string()),
      shotIds: z.array(z.string()),
      targetId: z.string(),
      afterShotId: z.string(),
      text: z.string(),
      view: z.string(),
      quality: z.string(),
      again: z.boolean(),
      light: z.string(),
      time: z.string(),
      shotType: z.string(),
      seconds: z.number(),
      lengths: z.array(z.object({ shotId: z.string(), seconds: z.number() })),
      look: z.string(),
    }),
  ),
})
export type RawPlan = z.infer<typeof rawPlanSchema>
type RawStep = RawPlan['steps'][number]

const PLAN_SHAPE = `{"reply": string, "steps": [{"op": string, "title": string, "sceneIds": [string], "shotIds": [string], "targetId": string, "afterShotId": string, "text": string, "view": string, "quality": string, "again": boolean, "light": string, "time": string, "shotType": string, "seconds": number, "lengths": [{"shotId": string, "seconds": number}], "look": string}]}`

/** The Director's system prompt for the chat: what it can plan (the app's own operations) and how. */
export function planSystem(): string {
  return `You are the Director in Wildroom, an app that makes short films and ads with AI image, video and voice models. The user talks to you in a chat beside their project. You never make anything yourself and nothing has happened yet: you answer briefly and propose a plan — steps the app runs only after the user approves them. The app shows each step's cost and time before asking.

The steps ("op") you can plan — each is something the app already does from its own buttons. Fill only the fields a step uses; leave the others empty ("", [], 0 or false):
- "write-script": a new short screenplay written from an idea, in place of the script. "text": the idea. Only when the user wants a new script, or the project has none.
- "outline": the script read into characters, places and scenes; replaces every scene and shot. Only right after "write-script", when there is a script but no scenes, or when the user asks to rebuild everything.
- "scene-shots": the shots of these scenes written (again) from their part of the script; replaces their shots. "sceneIds".
- "update-scenes": only the scenes whose part of the script was edited, written again. Only when the project says the script was edited.
- "improve-look": a character's or a place's look description rewritten. "targetId": its id; "text": what to change, if the user said.
- "place-view": another side of a place written out and drawn, for the user to approve. "targetId": the place id; "view": "reverse", "left" or "right".
- "asset-set": a set of brand, web or social images planned on the board from a brief. "text": the brief.
- "edit-scene": a scene's light or time of day changed. "targetId": the scene id; "light" and/or "time". Follow it with "stills" with "again": true for that scene's shots that have a still, so the pictures match the new light.
- "shot-lengths": shots made longer or shorter. "lengths": [{"shotId", "seconds"}], 2 to 20 seconds each — keep a shot with lines long enough to speak them (about 2.5 words a second).
- "add-shot": one new shot in a scene. "targetId": the scene id; "afterShotId": the shot it follows ("" = at the end of the scene); "text": what happens in it, present tense, with the characters' names; "shotType": its framing ("INSERT · 85mm", "WIDE"); "seconds".
- "stills": the shots' still pictures (keyframes) drawn. "shotIds"; "again": true to draw again shots that already have one.
- "voices": the shots' dialogue lines recorded with ElevenLabs. "shotIds" (shots with lines).
- "animate": video takes of the shots, made from their stills. "shotIds"; "quality": "draft" (cheap, what to plan normally) or "final" (only for shots that have a take, and only when the user asks for finals).
- "music": a music cue. "text": what it sounds like; "seconds".
- "sfx": a sound effect. "text"; "seconds".
- "update-timeline": the story laid out again on its Story cut timeline.
- "create-explainer": an animated explainer video (motion graphics: titles, text, shapes and pictures that come in as a narrator speaks), made on a new board and put at the end of the timeline. "text": the topic, or the script to follow, as the user gave it; "seconds": its length (default 45). Only when the user asks for an explainer, a motion-graphics or an animated presentation video — not for a film. "look": the explainer's look when the user asks for one (or it suits the topic): ${EXPLAINER_STYLE_IDS.filter((id) => id !== 'default')
  .map((id) => `"${id}" (${EXPLAINER_STYLES[id].description})`)
  .join(', ')}; "" for the plain one.

How to plan:
- The fewest steps that do what was asked, in the order they must run: script, outline, shots, edits, stills, voices, takes, music, timeline.
- Don't plan what the project already has: a shot with a ready still needs none unless the user asks to redraw it; still "redo" means it was rewritten and must be drawn again; "coming" is already on its way.
- Takes are made from stills: plan "stills" first for any shot you animate that has none (or a "redo" one).
- Use only ids listed in the project. Shots are named like "1.2" (scene 1, shot 2) — say "Shot 1.2" and "scene 2" in the reply.
- When something can't be done with these steps, or the user only asks a question, answer in the reply and return no steps.
- "reply": one to three short sentences in the user's language: what you plan and why, never that it is done.
- "title": the line the user reads for the step on the plan card, short and concrete ("Redraw the 4 stills of scene 2 at golden hour", "Draft takes for shots 1.1–1.4").`
}

const clip = (text: string | undefined, max: number) => {
  const t = (text ?? '').replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** The project in a few lines: what the Director plans from. */
export function projectSummary(p: DirectorContext): string {
  const lines: string[] = []
  const usd = (n: number) => `$${n.toFixed(2)}`
  lines.push(
    [
      `Project: ${p.name ? `"${clip(p.name, 80)}"` : 'untitled'}${p.kind ? ` (${p.kind})` : ''}`,
      p.title && p.title !== p.name ? `film title "${clip(p.title, 80)}"` : '',
      p.style ? `visual style: ${clip(p.style, 200)}` : '',
      `brand look ${p.brandOn ? 'on' : 'off'}`,
      p.budgetUsd ? `budget ${usd(p.budgetUsd)}${p.spentUsd !== undefined ? `, spent ${usd(p.spentUsd)}` : ''}` : p.spentUsd !== undefined ? `spent ${usd(p.spentUsd)}` : '',
    ]
      .filter(Boolean)
      .join(' · '),
  )
  if (p.logline) lines.push(`Logline: ${clip(p.logline, 300)}`)
  const m = p.models
  lines.push(
    `Models: stills ${m.image ?? 'none'} · takes ${m.video ?? 'none'}${m.finalVideo ? ` (finals ${m.finalVideo})` : ''} · voices ${m.voice ?? 'none'}`,
  )
  if (!p.script.length) lines.push('Script: empty.')
  else {
    lines.push(`Script: ${p.script.length} characters${p.script.edited ? ', edited since the scenes were made from it' : ''}.`)
    lines.push(`--- script${p.script.excerpt.length < p.script.length ? ' (the start)' : ''} ---\n${p.script.excerpt}\n--- end of script ---`)
  }
  lines.push(
    p.cast.length
      ? `Cast: ${p.cast.map((c) => `${c.name} [id ${c.id}] (${c.picture ? 'has a picture' : 'no picture'}, ${c.voice ? 'has a voice' : 'no voice'})`).join(' · ')}`
      : 'Cast: none yet.',
  )
  lines.push(
    p.places.length
      ? `Places: ${p.places.map((x) => `${x.name} [id ${x.id}] (${x.picture ? `pictures: ${x.views.join(', ') || 'main'}` : 'no picture'})`).join(' · ')}`
      : 'Places: none yet.',
  )
  if (!p.scenes.length) lines.push('Scenes: none yet (the script has not been outlined).')
  else {
    const shots = p.scenes.flatMap((s) => s.shots)
    const seconds = Math.round(shots.reduce((n, x) => n + x.seconds, 0))
    lines.push(`Scenes: ${p.scenes.length}, ${shots.length} shots, ${seconds} s in all.`)
    for (const s of p.scenes) {
      const about = [s.place, s.time, s.light && `light: ${clip(s.light, 120)}`].filter(Boolean).join(' · ')
      lines.push(`Scene ${s.n} [id ${s.id}] "${clip(s.title, 100)}"${about ? ` · ${about}` : ''}${s.shots.length ? '' : ' · no shots written yet'}`)
      if (s.summary) lines.push(`  ${clip(s.summary, 240)}`)
      for (const x of s.shots) {
        lines.push(
          `  ${x.n} [id ${x.id}] ${Math.round(x.seconds * 10) / 10} s · still ${x.still} · take ${x.take} · ${x.lines} line${x.lines === 1 ? '' : 's'} · ${clip(x.what, 160)}`,
        )
      }
    }
  }
  lines.push(`Story cut timeline: ${p.storyCut ? 'laid out' : 'not laid out yet'}.`)
  return lines.join('\n')
}

export function planUserPrompt(req: DirectorPlanRequest): string {
  const history = (req.history ?? []).slice(-8).map((t) => `${t.role === 'user' ? 'User' : 'Director'}: ${clip(t.text, 800)}`)
  return [projectSummary(req.project), history.length ? `The conversation so far:\n${history.join('\n')}` : '', `The user now says: ${req.message.trim()}`]
    .filter(Boolean)
    .join('\n\n')
}

/** The steps' running order: a stable sort keeps the model's order within one kind. */
const OP_ORDER: Record<PlanOp, number> = {
  'write-script': 0,
  outline: 1,
  'update-scenes': 2,
  'scene-shots': 3,
  'edit-scene': 4,
  'shot-lengths': 5,
  'add-shot': 6,
  'improve-look': 7,
  'place-view': 8,
  stills: 9,
  voices: 10,
  animate: 11,
  music: 12,
  sfx: 13,
  'update-timeline': 14,
  'asset-set': 15,
  'create-explainer': 16,
}

const DEFAULT_TITLES: Record<PlanOp, string> = {
  'write-script': 'Write the script from your idea',
  outline: 'Outline the script into cast, places and scenes',
  'scene-shots': 'Write the shots',
  'update-scenes': 'Rewrite the scenes whose script changed',
  'improve-look': 'Improve the look',
  'place-view': 'Draw another side of the place',
  'asset-set': 'Plan the images on the board',
  'edit-scene': 'Change the scene',
  'shot-lengths': 'Change the shot lengths',
  'add-shot': 'Add a shot',
  stills: 'Draw the stills',
  voices: 'Record the lines',
  animate: 'Make the takes',
  music: 'Write the music',
  sfx: 'Make the sound effect',
  'update-timeline': 'Update the timeline',
  'create-explainer': 'Make the explainer',
}

/** Looks the project's things up by id, or by what the model may have written instead (a shot's "1.2", a name). */
function resolver(p: DirectorContext) {
  const shots = p.scenes.flatMap((s) => s.shots)
  const norm = (v: string) => v.trim().toLowerCase().replace(/^(shot|scene)\s+/, '')
  return {
    shot: (v: string) => shots.find((x) => x.id === v.trim()) ?? shots.find((x) => x.n === norm(v)),
    scene: (v: string) => p.scenes.find((s) => s.id === v.trim()) ?? p.scenes.find((s) => String(s.n) === norm(v)),
    character: (v: string) => p.cast.find((c) => c.id === v.trim()) ?? p.cast.find((c) => c.name.toLowerCase() === norm(v)),
    place: (v: string) => p.places.find((x) => x.id === v.trim()) ?? p.places.find((x) => x.name.toLowerCase() === norm(v)),
    shots,
  }
}

const unique = <T,>(items: T[]) => [...new Set(items)]

/**
 * The model's steps as the app's: ops it doesn't know dropped, ids looked up (an unknown one dropped, a step left
 * with nothing to do dropped), lengths clamped, titles filled in, in running order, at most PLAN_STEPS_MAX.
 */
export function sanitizePlan(raw: RawPlan, req: Pick<DirectorPlanRequest, 'message' | 'project'>): { reply: string; steps: PlanStep[] } {
  const find = resolver(req.project)
  const shotIds = (r: RawStep) => unique(r.shotIds.flatMap((v) => find.shot(v)?.id ?? []))
  const sceneOf = (r: RawStep) => find.scene(r.targetId) ?? (r.sceneIds[0] ? find.scene(r.sceneIds[0]) : undefined)
  const filmSeconds = Math.round(find.shots.reduce((n, x) => n + x.seconds, 0))
  const clamp = (v: number, lo: number, hi: number, fallback: number) => (Number.isFinite(v) && v > 0 ? Math.min(hi, Math.max(lo, v)) : fallback)
  const out: PlanStep[] = []
  for (const r of raw.steps) {
    if (!(PLAN_OPS as readonly string[]).includes(r.op)) continue
    const op = r.op as PlanOp
    const title = r.title.trim() || DEFAULT_TITLES[op]
    const text = r.text.trim()
    let step: unknown
    switch (op) {
      case 'write-script':
        step = { op, title, idea: text || req.message.trim() }
        break
      case 'outline':
      case 'update-scenes':
      case 'update-timeline':
        step = { op, title }
        break
      case 'scene-shots':
        step = { op, title, sceneIds: unique([...r.sceneIds, ...(r.targetId ? [r.targetId] : [])].flatMap((v) => find.scene(v)?.id ?? [])) }
        break
      case 'improve-look': {
        const c = find.character(r.targetId)
        const p = c ? undefined : find.place(r.targetId)
        step = c || p ? { op, title, kind: c ? 'character' : 'place', id: (c ?? p)!.id, ...(text ? { note: text } : {}) } : undefined
        break
      }
      case 'place-view':
        step = { op, title, placeId: find.place(r.targetId)?.id, view: r.view.trim().toLowerCase() }
        break
      case 'asset-set':
        step = { op, title, brief: text || req.message.trim() }
        break
      case 'create-explainer':
        step = {
          op,
          title,
          topic: text || req.message.trim(),
          seconds: Math.round(clamp(r.seconds, 10, 600, 45)),
          ...((EXPLAINER_STYLE_IDS as readonly string[]).includes(r.look) && r.look !== 'default' ? { style: r.look as ExplainerStyleId } : {}),
        }
        break
      case 'edit-scene': {
        const light = r.light.trim()
        const time = r.time.trim()
        step = light || time ? { op, title, sceneId: sceneOf(r)?.id, ...(light ? { light } : {}), ...(time ? { time } : {}) } : undefined
        break
      }
      case 'shot-lengths': {
        const lengths = r.lengths.flatMap((l) => {
          const shot = find.shot(l.shotId)
          return shot && Number.isFinite(l.seconds) ? [{ shotId: shot.id, seconds: Math.round(clamp(l.seconds, 1, 30, shot.seconds) * 10) / 10 }] : []
        })
        step = { op, title, lengths: [...new Map(lengths.map((l) => [l.shotId, l])).values()] }
        break
      }
      case 'add-shot': {
        const after = r.afterShotId ? find.shot(r.afterShotId) : undefined
        const scene = sceneOf(r)
        step = {
          op,
          title,
          sceneId: scene?.id,
          ...(after && scene?.shots.some((x) => x.id === after.id) ? { afterShotId: after.id } : {}),
          action: text,
          ...(r.shotType.trim() ? { shotType: r.shotType.trim() } : {}),
          seconds: clamp(r.seconds, 1, 30, 4),
        }
        break
      }
      case 'stills':
        step = { op, title, shotIds: shotIds(r), ...(r.again ? { again: true } : {}) }
        break
      case 'voices':
        step = { op, title, shotIds: shotIds(r).filter((id) => (find.shots.find((x) => x.id === id)?.lines ?? 0) > 0) }
        break
      case 'animate':
        step = { op, title, shotIds: shotIds(r), quality: r.quality.trim().toLowerCase() === 'final' ? 'final' : 'draft' }
        break
      case 'music':
        step = { op, title, prompt: text || req.message.trim(), seconds: Math.round(clamp(r.seconds, 5, 180, clamp(filmSeconds, 5, 180, 30))) }
        break
      case 'sfx':
        step = { op, title, prompt: text || req.message.trim(), seconds: clamp(r.seconds, 0.5, 30, 4) }
        break
    }
    const parsed = planStepSchema.safeParse(step)
    if (parsed.success) out.push(parsed.data)
  }
  // The same pass twice (the model repeated itself) runs once.
  const seen = new Set<string>()
  const steps = out
    .filter((s) => {
      const key = JSON.stringify({ ...s, title: '' })
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .map((s, i) => ({ s, i }))
    .sort((a, b) => OP_ORDER[a.s.op] - OP_ORDER[b.s.op] || a.i - b.i)
    .map((x) => x.s)
    .slice(0, PLAN_STEPS_MAX)
  return { reply: raw.reply.trim() || (steps.length ? 'Here is the plan.' : 'I couldn’t plan that.'), steps }
}

// ---- demo rules: no text model, a few requests read by keywords

const emptyStep = (op: PlanOp, title = ''): RawStep => ({
  op,
  title,
  sceneIds: [],
  shotIds: [],
  targetId: '',
  afterShotId: '',
  text: '',
  view: '',
  quality: '',
  again: false,
  light: '',
  time: '',
  shotType: '',
  seconds: 0,
  lengths: [],
  look: '',
})

const DEMO_NOTE = 'Demo rules (no AI)'
const LIGHTS: [RegExp, string, string][] = [
  [/golden|sunset|magic hour/, 'low golden-hour sun, warm and soft, long shadows', 'golden hour'],
  [/dusk|evening|twilight/, 'fading blue dusk light, warm practical lights coming on', 'dusk'],
  [/night|moon/, 'cool moonlight with warm practical lights', 'night'],
  [/dawn|sunrise|morning/, 'soft pale dawn light, light mist', 'dawn'],
  [/noon|midday|harsh/, 'hard high noon sun, short shadows', 'noon'],
]

/**
 * Offline fallback for demo mode: a few requests read by keywords — the outline from an idea, stills, voices, takes,
 * finals, golden-hour light, a shot added, a target length, music, a sound effect, the timeline. Anything else gets an
 * honest "can't" and no steps.
 */
export function demoPlan(req: Pick<DirectorPlanRequest, 'message' | 'project'>): RawPlan {
  const p = req.project
  const text = req.message.trim()
  const q = text.toLowerCase()
  const find = resolver(p)
  const sceneNo = /\bscen[ea]\s*(\d+)/.exec(q)
  const scene = sceneNo ? find.scene(sceneNo[1]!) : undefined
  const pool = scene ? scene.shots : find.shots
  const label = (ids: string[]) => {
    const names = ids.map((id) => find.shots.find((x) => x.id === id)!.n)
    return names.length > 3 ? `${names.length} shots` : `shot${names.length === 1 ? '' : 's'} ${names.join(', ')}`
  }
  const steps: RawStep[] = []
  const notes: string[] = []

  // An explainer is its own thing: one step, whatever the story has.
  if (/\bexplain(er)?\b|motion graphics/.test(q)) {
    const seconds = /(\d+)\s*(s|sec|seconds?)\b/.exec(q)
    return {
      reply: `${DEMO_NOTE}: I’ll make the explainer with simple rules — one scene per sentence of what you wrote. Add a Director key (Settings → Providers) for real writing.`,
      steps: [{ ...emptyStep('create-explainer', 'Make the explainer'), text, seconds: seconds ? Number(seconds[1]) : 45 }],
    }
  }

  // No scenes yet: the idea becomes the script (when there is none), then the outline.
  if (!p.scenes.length) {
    if (!p.script.length || /\b(film|story|ad|about|write)\b/.test(q)) steps.push({ ...emptyStep('write-script', 'Write the script from your idea'), text })
    steps.push(emptyStep('outline', 'Outline it into cast, places and scenes'))
    return {
      reply: `${DEMO_NOTE}: I’ll ${steps.length > 1 ? 'put your idea in the script and ' : ''}outline it with simple rules — a placeholder, not a real script. Add a Director key (Settings → Providers) for a real one.`,
      steps,
    }
  }

  if (/update scenes|script (changed|edited)/.test(q) || (/\bupdate\b/.test(q) && p.script.edited)) {
    steps.push(emptyStep('update-scenes', 'Rewrite the scenes whose script changed'))
    notes.push('rewrite the edited scenes')
  }
  if (/write (the )?shots|break .*shots|shot list/.test(q)) {
    const todo = (scene ? [scene] : p.scenes.filter((s) => !s.shots.length)).map((s) => s.id)
    if (todo.length) {
      steps.push({ ...emptyStep('scene-shots', `Write the shots of ${todo.length === 1 ? `scene ${find.scene(todo[0]!)!.n}` : `${todo.length} scenes`}`), sceneIds: todo })
      notes.push('write the shots')
    }
  }
  const light = LIGHTS.find(([re]) => re.test(q))
  if (light && scene && /light|hour|make|turn|set|at /.test(q)) {
    steps.push({ ...emptyStep('edit-scene', `Scene ${scene.n} at ${light[2]}`), targetId: scene.id, light: light[1], time: light[2] })
    const redraw = scene.shots.filter((x) => x.still !== 'none').map((x) => x.id)
    if (redraw.length) steps.push({ ...emptyStep('stills', `Redraw ${redraw.length} still${redraw.length === 1 ? '' : 's'} of scene ${scene.n} at ${light[2]}`), shotIds: redraw, again: true })
    notes.push(`move scene ${scene.n} to ${light[2]}${redraw.length ? ' and redraw its stills — takes only after you’ve checked them' : ''}`)
  }
  const add = /\badd (?:a |an |one )?(?:new )?(?:shot|insert)(?: of| with| where)?\s*(.*)$/.exec(q) ?? /\banother shot(?: of)?\s*(.*)$/.exec(q)
  if (add) {
    const target = scene ?? p.scenes.at(-1)!
    const what =
      text
        .slice(text.length - add[1]!.length)
        .replace(/[.!?]+$/, '')
        .replace(/\s+(?:in|to|into|for)\s+scen[ea]\s*\d+$/i, '')
        .trim() || 'a close detail of the action'
    steps.push({ ...emptyStep('add-shot', `Add a shot at the end of scene ${target.n}: ${what}`), targetId: target.id, text: `A close shot of ${what}.`, shotType: 'INSERT · 85mm', seconds: 3 })
    notes.push(`add a 3 s insert of ${what} to scene ${target.n}`)
  }
  const target = /(\d+)\s*(?:s\b|sec|seconds)/.exec(q)
  if (target && /make it|shorter|longer|cut (it )?(down )?to|trim|length|long/.test(q) && find.shots.length) {
    const want = Number(target[1])
    const now = find.shots.reduce((n, x) => n + x.seconds, 0)
    if (want > 0 && now > 0 && Math.abs(want - now) >= 1) {
      const k = want / now
      const lengths = find.shots.map((x) => ({ shotId: x.id, seconds: Math.max(2, Math.min(20, Math.round(x.seconds * k * 2) / 2)) }))
      const total = lengths.reduce((n, l) => n + l.seconds, 0)
      steps.push({ ...emptyStep('shot-lengths', `Every shot ${k < 1 ? 'shorter' : 'longer'} · about ${Math.round(total)} s in all`), lengths })
      notes.push(`scale every shot’s length so the film runs about ${Math.round(total)} s (lines may no longer fit — check them)`)
    }
  }
  const missing = (ids: string[]) => ids.filter((id) => ['none', 'redo'].includes(find.shots.find((x) => x.id === id)!.still))
  const animate = /\banimat|\btakes?\b|\bvideo|\bclips?\b|\bdrafts?\b|\brender/.test(q) && !/\bfinal/.test(q)
  const stills = /\bstills?\b|\bpictures?\b|\bkeyframes?\b|\bframes?\b|\bdraw\b/.test(q) && !light
  if (stills || animate) {
    const want = stills && /\bagain\b|\bredraw\b/.test(q) ? pool.map((x) => x.id) : missing(pool.map((x) => x.id))
    if (want.length) {
      steps.push({ ...emptyStep('stills', `Stills for ${label(want)}`), shotIds: want, again: stills && /\bagain\b|\bredraw\b/.test(q) })
      notes.push(`draw the stills of ${label(want)}`)
    }
  }
  if (/\bvoices?\b|\blines?\b|\bdialog|\brecord/.test(q)) {
    const want = pool.filter((x) => x.lines > 0).map((x) => x.id)
    if (want.length) {
      steps.push({ ...emptyStep('voices', `Record the lines of ${label(want)}`), shotIds: want })
      notes.push(`record the lines of ${label(want)}`)
    }
  }
  if (animate) {
    const want = pool.filter((x) => x.take === 'none').map((x) => x.id)
    if (want.length) {
      steps.push({ ...emptyStep('animate', `Draft takes for ${label(want)}`), shotIds: want, quality: 'draft' })
      notes.push(`make draft takes of ${label(want)}`)
    }
  }
  if (/\bfinals?\b/.test(q)) {
    const want = pool.filter((x) => x.take === 'draft').map((x) => x.id)
    if (want.length) {
      steps.push({ ...emptyStep('animate', `Finals of the chosen takes of ${label(want)}`), shotIds: want, quality: 'final' })
      notes.push(`render finals of ${label(want)}`)
    }
  }
  if (/\bmusic\b|\bscore\b|\bsoundtrack\b/.test(q)) {
    const seconds = Math.min(180, Math.max(5, Math.round(find.shots.reduce((n, x) => n + x.seconds, 0)) || 30))
    // "Write music for it" says nothing about the music: the film's style and logline do.
    const asked = text.replace(/^(please\s+)?(write|make|add|compose)\s+(some\s+)?/i, '').trim()
    const prompt = asked.split(/\s+/).length >= 4 ? asked : [`A score for the film${p.title ? ` "${p.title}"` : ''}`, p.logline, p.style].filter(Boolean).join('. ')
    steps.push({ ...emptyStep('music', `Music · ${seconds} s`), text: prompt, seconds })
    notes.push(`write a ${seconds} s music cue`)
  }
  if (/\bsound effects?\b|\bsfx\b|\bambien/.test(q)) {
    steps.push({ ...emptyStep('sfx', 'Sound effect · 4 s'), text, seconds: 4 })
    notes.push('make the sound effect')
  }
  if (/\btimeline\b|\bassemble\b|\bstory cut\b/.test(q)) {
    steps.push(emptyStep('update-timeline', 'Lay the story out on the Story cut'))
    notes.push('lay the story out on the timeline')
  }
  if (/\b(brand|social|banner|poster|thumbnail|instagram|assets?)\b/.test(q)) {
    steps.push({ ...emptyStep('asset-set', 'Plan the images on the board'), text })
    notes.push('plan the images on the board')
  }

  if (!steps.length) {
    return {
      reply: `${DEMO_NOTE} understand only a few requests: stills, voices, takes, finals, golden-hour light for a scene, adding a shot, a target length, music, a sound effect and the timeline. Add a Director key (Settings → Providers) for anything else.`,
      steps: [],
    }
  }
  const said = notes.length > 1 ? `${notes.slice(0, -1).join(', ')} and ${notes.at(-1)}` : notes[0]
  return { reply: `${DEMO_NOTE}: I’ll ${said}.`, steps }
}

/**
 * The chat's answer: what the Director says and the plan it proposes — through the Director's text model when a key
 * can run it, else (demo mode) the demo rules; never a plan the app can't run.
 */
export async function planDirector(
  req: DirectorPlanRequest,
  creds: DirectorCredentials,
  demoMode: boolean,
  call: typeof structuredCall = structuredCall,
): Promise<DirectorPlanResponse> {
  if (!req.message?.trim()) throw new ApiError(400, 'Write a message first')
  if (creds.anthropic || creds.openrouter || creds.fal) {
    const { result, via, model } = await call(creds, planSystem(), planUserPrompt(req), rawPlanSchema, PLAN_SHAPE, 'medium')
    return { ...sanitizePlan(result, req), via, model }
  }
  if (demoMode) return { ...sanitizePlan(demoPlan(req), req), via: 'demo', model: 'local rules' }
  throw new ApiError(400, 'The AI Director needs an Anthropic, OpenRouter or fal.ai key (Settings → Providers)')
}
