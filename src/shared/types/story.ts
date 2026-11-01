/** Script → shots → generated media. Lives on the project document (undoable, autosaved). */

export interface StoryCharacter {
  id: string
  name: string
  description: string
  /** ElevenLabs voice id. */
  voiceId?: string
  /**
   * How the character sounds, in words ("warm, low female voice that trembles but holds"): video models that voice the
   * lines themselves are told it with every line, so a line isn't given to the wrong voice.
   */
  voice?: string
  /**
   * A few seconds of this character speaking (an audio asset): video models that take voice references (LTX with
   * Licon's subject references) give their lines this voice, the same in every clip.
   */
  voiceSampleAssetId?: string
  /** Reference image asset for visual consistency (the frontal view when synced to Kling). */
  refAssetId?: string
  /** Extra reference images (other angles / close-ups). Kling elements take 1–3 of them besides the frontal one. */
  refAssetIds?: string[]
  /**
   * The character alone on a plain grey background, standing, in full wardrobe: LTX's subject references (Licon MSR)
   * copy whatever a reference shows — a skyline or a chair behind the face ends up in the clip — so LTX gets this one.
   */
  videoRefAssetId?: string
  /** The render that makes `videoRefAssetId`; its output becomes it when ready. */
  videoRefGenerationId?: string
  /** Pictures made in the look designer, oldest first. */
  designTakes?: DesignTake[]
  /**
   * Notes for drawing the reference pictures only ("on a plain grey background, full body"): the look designer reads
   * them, no shot or clip prompt does — left in the look, "Only one shoot on gray background" rode along into every
   * LTX shot of Impossible Worlds.
   */
  pictureNotes?: string
  /** The look designer's quick picks: `description` starts with what they say (composeLook), the details follow. */
  picks?: LookPicks
  /** The character as a Kling element (element library), created from `sourceAssetIds` at `syncedAt`. */
  kling?: {
    elementId: string
    /** ISO timestamp of the sync. */
    syncedAt: string
    /** [frontal, ...references] asset ids the element was built from; differs from the current refs → stale. */
    sourceAssetIds: string[]
  }
}

/** A location: its look and reference images keep the setting the same in every keyframe shot there. */
/**
 * The four directions a place is seen in: the main view (its establishing photo), the reverse (looking back toward
 * where that camera stands), and 90° to its left and right — a 360° in quarters.
 */
export type PlaceView = 'main' | 'reverse' | 'left' | 'right'
export const PLACE_VIEWS: readonly PlaceView[] = ['main', 'reverse', 'left', 'right']

/**
 * The look designer's quick picks, by group ("who" → "Woman", "face" → ["Freckles", "Glasses"]): they write the start
 * of the look (see design.ts composeLook), and are kept so the designer shows them again.
 */
export type LookPicks = Record<string, string | string[]>

export interface StoryPlace {
  id: string
  name: string
  description: string
  /** Reference images of the place, the main view first. */
  refAssetIds?: string[]
  /** What each reference shows ("the WKD ticket machine"), by asset id: named in the keyframe prompt, and shots that mention it get that photo first. */
  refNotes?: Record<string, string>
  /**
   * Who stands where here ("Maja on the left at the ticket machine, Tymon on the right"): every keyframe and clip set
   * here keeps it, so close-ups and reverse shots keep the sides of the establishing shot.
   */
  blocking?: string
  /** One coherent light logic for the place (source, direction, time of day) — Lightricks: mixed light confuses LTX. */
  light?: string
  /** Pictures made in the look designer, oldest first. */
  designTakes?: DesignTake[]
  /** Notes for drawing the place's pictures only (as StoryCharacter.pictureNotes): never in a shot's or a clip's prompt. */
  pictureNotes?: string
  /** The look designer's quick picks (as StoryCharacter.picks). */
  picks?: LookPicks
}

export interface StoryLine {
  id: string
  characterId?: string
  text: string
  generationId?: string
  /** Free macOS voice for the animatic, cached: remade only when `text` no longer matches the line or the asset is gone. */
  tempVoice?: { assetId: string; text: string; seconds?: number }
}

/** A movement of the story (an act, a sequence): groups scenes in the outline and marks the timeline. */
export interface StoryChapter {
  id: string
  title: string
  summary?: string
}

/**
 * One continuous piece of action in one place and time. Its shots inherit what is set here — the place, the light and
 * where everyone stands — unless a shot says otherwise; its first keyframe is the layout every other keyframe follows.
 */
export interface StoryScene {
  id: string
  /** StoryDoc.chapters; unset while the story has no chapters. */
  chapterId?: string
  /** The heading ("Roadside past Włoszczowa"). */
  title: string
  /** What happens, in a sentence or two (the outline's beat). */
  summary?: string
  /** This scene's part of the script: what its shots are written from. */
  script?: string
  /** Where it happens (StoryDoc.places): new shots get it, and setting it moves the shots that had the old one. */
  placeId?: string
  /** Time of day ("dusk"). */
  time?: string
  /** Replaces the place's light for this scene. */
  light?: string
  /** Replaces the place's blocking for this scene (a shot's own blocking still wins). */
  blocking?: string
  /** Who is in it (StoryDoc.characters). */
  castIds?: string[]
  /** It picks up right where the previous scene ends: its opening keyframe is drawn from that scene's last frame. */
  continuesPrevious?: boolean
  /** How many shots to write for it (unset: the Director decides). */
  targetShots?: number
}

/** A shot's Blender previs: renders of one camera's stretch of the grey-box scene, imported as project assets. */
export interface StoryShotPrevis {
  /** The grey-box render (flat colours per character and prop): what the camera guide follows. */
  assetId: string
  /** The same stretch as depth (light = near): the guide for a shot without a start frame. */
  depthAssetId?: string
  /** The render's first frame: what the shot's keyframe is drawn over (same composition, the story's look). */
  firstFrameAssetId?: string
  /** Frames at the render's rate (8k+1). */
  frames?: number
  /** The render's frame rate (unset: 24). */
  fps?: number
  /** Who each coloured figure is ({ color: 'blue', name: 'Maja' }): named when the keyframe is drawn over the render. */
  figures?: { color: string; name: string }[]
  /** Where it came from, e.g. "previs_test.blend · CamShot2". */
  source?: string
}

export interface StoryShot {
  id: string
  /** StoryDoc.scenes: the scene the shot belongs to (shots are kept together, in scene order). */
  sceneId?: string
  /**
   * The scene's heading as text: what older builds group shots by. Kept for them, and for stories from before scenes,
   * which get their scenes from it on load (see sanitizeStory).
   */
  scene?: string
  /**
   * Continuous action from the previous shot, no cut: its take starts where the previous shot's take ends (that clip's
   * ending, or its last frame), so it waits for it.
   */
  continues?: boolean
  description: string
  shotType?: string
  /**
   * Where the camera stands and which way it looks, by the place's landmarks ("on the pier's end, looking back at the
   * bank, over Kuba's shoulder onto Stefan"): without it a closer shot's keyframe came back from the opening wide's
   * camera, everyone with their back to it.
   */
  view?: string
  /**
   * The keyframe: the shot's first moment as one picture — who is where in the frame, which way each faces the camera,
   * pose and expression, what is behind them. The keyframe is drawn from it instead of the prompt, whose sequence of
   * beats ("listens, then turns to Kuba") an image can't show.
   */
  frame?: string
  /**
   * Which of the place's views is behind the subject from this camera (unset: the main view). A place drawn from one
   * view put that view behind every shot — the lake behind both sides of a conversation (By the Lake, 1.2–1.5) — so a
   * keyframe gets the place's photo of this direction, and its layout from earlier keyframes facing the same way.
   */
  background?: PlaceView
  camera?: string
  /**
   * A Blender previs of the shot (docs/blender-previs.md): the grey-box render the video follows for its camera and
   * placement (LTX on the GPU's camera guide), with its depth render and first frame when exported.
   */
  previs?: StoryShotPrevis
  /** Prompt for the video model (no dialogue text inside). */
  prompt: string
  /** Seconds. */
  duration: number
  /** Characters whose face is in the shot. */
  characterIds: string[]
  /**
   * Characters only partly in the shot — from behind (the foreground shoulder of an over-the-shoulder shot) or just
   * their hands: their references and looks go with the shot, but they don't lip-sync.
   */
  partialIds?: string[]
  /**
   * Characters in the frame only as an unreadable dark outline or silhouette — someone waiting in the shadows to be
   * revealed: no face reference, no lip sync, no video reference (given a studio face reference, the hidden man of The
   * Chase came out lit).
   */
  hiddenIds?: string[]
  /** Where the shot takes place (StoryDoc.places). */
  placeId?: string
  /**
   * Who stands where in this shot when it isn't the place's blocking (they regroup: "left to right: Zosia, Hanka, Jan,
   * shoulder to shoulder"): replaces the place's for this shot, in its keyframe and its clip.
   */
  blocking?: string
  /**
   * The light in this shot when it isn't the scene's ("a torch beam from below"): replaces the scene's (else the
   * place's) light in its still and its clip (see lightOf).
   */
  light?: string
  dialogue: StoryLine[]
  sfx?: string
  keyframeGenerationId?: string
  keyframeAssetId?: string
  /** Earlier keyframes (asset ids, or generation ids still rendering), newest last: a new keyframe never loses the old one. */
  keyframeHistory?: string[]
  /**
   * The shot was written again (Update scenes) after its still was drawn: the still shows the old text ("Still ·
   * redo"). Cleared when another still is drawn, picked or removed, or the user keeps this one.
   */
  stillStale?: boolean
  /**
   * The shot's last moment as one picture, written by the Director when the shot ends somewhere its first frame can't
   * predict — a structure rising from the ground, a reveal, a large camera move. Its end keyframe is drawn from the
   * shot's own keyframe and the clip renders between the two (LTX first/last frame): told only in words, LTX invented
   * a kilometre-wide ring structure anew in every shot (Kael, Impossible Worlds).
   */
  endFrame?: string
  endKeyframeGenerationId?: string
  endKeyframeAssetId?: string
  /**
   * How alike the start and end keyframes are (SSIM, see shared/story/endFrame), measured for these two stills: stale
   * once either is redrawn (endCheckFresh).
   */
  endCheck?: { startId: string; endId: string; ssim: number }
  /** The user's call on the end keyframe: sent as the last frame ('image'), or only its description ('text'). Unset: by the verdict. */
  endUse?: 'image' | 'text'
  videoGenerationIds: string[]
  chosenAssetId?: string
  /** The final render of the chosen take: it becomes the chosen take once ready (picking a take clears it). */
  finalGenerationId?: string
  /**
   * "Render with…": the video model for this shot's takes (a model id). Unset = the story's video model; a shot in a
   * multi-shot group renders with the group's model instead.
   */
  modelId?: string
  /** What each take (generation id) was rendered with; takes from before these records have none. */
  takes?: Record<string, ShotTake>
  /**
   * The shot's ElevenLabs lines mixed into one track as long as the shot (lead-in, gaps, silence to the end): LTX makes
   * a dialogue shot to it (audio to follow). Remade when `key` (the lines and the length) no longer matches.
   */
  voiceTrack?: { assetId: string; key: string }
}

/** What a group is made from: the first shot's keyframe, the cast's references, or both (see StoryMultishot.source). */
export type StorySource = 'keyframe' | 'references' | 'both'

/** What one shot take was rendered with: compared side by side, and told apart from finals (see finalTakeIds). */
export interface ShotTake {
  modelId: string
  /** What it was made from: its keyframe, the cast's references, both, or neither (text only). */
  source?: StorySource
  /** Made to the shot's voice track (audio to follow): its sound already holds the lines, so assembling adds none. */
  voiceTrackAssetId?: string
  /** A continuing shot's take: started from the previous shot's take (its ending as a clip, or its last frame). */
  startFrom?: { shotId: string; assetId: string; via: 'clip' | 'frame' }
}

/** Interior cut times (seconds from the take's t=0) of one multi-shot take, and what the take was rendered with. */
export interface MultishotTakeCuts {
  /** Where the prompt put the cuts when the take was started (later shot edits don't move them). */
  planned: number[]
  /** The clip length the plan was written for. */
  total?: number
  /** Seconds of opening beat asked for before the first shot (LTX from references), cut away when assembling. */
  opener?: number
  /** Where scene detection found cuts in the rendered picture (the model doesn't keep to the plan). */
  detected?: number[]
  /** The scene score that detection ran at (older takes: 0.3); one that found too few cuts runs again lower. */
  threshold?: number
  /** The video model that rendered the take (older takes have none: see takeModelId). */
  modelId?: string
  /** What it was made from. */
  source?: StorySource
}

/**
 * Consecutive shots rendered as one clip with hard cuts, as many as one clip of the target model takes (its workflow's
 * multishot: 3 shots in 10 s for LTX-2.5 on RunPod, 2 in 8 s locally; LTX's cuts are written into the prompt). Takes
 * belong to the group; assembling cuts the chosen take back into its shots.
 */
export interface StoryMultishot {
  id: string
  /** Consecutive shots, in story order. */
  shotIds: string[]
  videoGenerationIds: string[]
  chosenAssetId?: string
  /** See StoryShot.finalGenerationId. */
  finalGenerationId?: string
  /** Per take (generation id): planned and detected cuts, used to split the take back into its shots. */
  takes?: Record<string, MultishotTakeCuts>
  /**
   * What the clip is made from: the first shot's keyframe (the rest from the prompt), the cast's and the place's
   * references (Licon MSR, Veo's ingredients, Kling O3's elements — no keyframe), or both (the keyframe as the start
   * frame with the cast as Kling elements). Unset = automatic (see groupSource); the model decides which it offers.
   */
  source?: StorySource
  /** "Render with…": the video model for this group's takes (a model id). Unset = the story's video model. */
  modelId?: string
}

export interface StoryDoc {
  /** The film's title (the outline's). */
  title?: string
  /** The story in a sentence. */
  logline?: string
  script: string
  style: string
  characters: StoryCharacter[]
  places?: StoryPlace[]
  /** In order. Optional: a story can have scenes without chapters. */
  chapters?: StoryChapter[]
  /** In order (by chapter, when there are chapters); set as soon as there are shots (see sanitizeStory). */
  scenes?: StoryScene[]
  /** Flat, in story order: each scene's shots together, the scenes in order. */
  shots: StoryShot[]
  multishots?: StoryMultishot[]
  imageModelId?: string
  /** The look designer's image model (the cast's and places' pictures); none: the stills' image model. */
  designModelId?: string
  videoModelId?: string
  /** Draft → final: chosen draft takes are rendered again with this (better, pricier) video model. */
  finalVideoModelId?: string
  /** The video model's settings for every story render (resolution, fps…), and the final model's — e.g. 1080p drafts, 4K finals. */
  videoSettings?: Record<string, unknown>
  finalVideoSettings?: Record<string, unknown>
  /**
   * Takes rendered as finals (generation ids). The one record of it: with per-shot and per-group models a take made
   * with the final model needn't be a final (only takes without a take record are judged by their model).
   */
  finalTakeIds?: string[]
  voiceModelId?: string
  /** What the user means to spend on this project's generations (USD); the storyboard warns before going over. */
  budgetUsd?: number
  /**
   * The script as it was when the scenes were made from it (Create scenes, Update scenes): Update scenes compares the
   * script with it, so only the scenes whose part changed are written again.
   */
  outlinedFrom?: string
  /**
   * The project's "Story cut" timeline (TimelineEntry id): Update timeline and the animatic replace its content in one
   * undo step, instead of adding the story to whatever timeline is open.
   */
  cutTimelineId?: string
  /**
   * What the Story cut held right after it was last laid out (a fingerprint of its clips, see cutSignature): it differs
   * once the cut was edited by hand, so replacing it asks first.
   */
  cutSignature?: string
}

export function emptyStory(): StoryDoc {
  return { script: '', style: '', characters: [], shots: [] }
}

/** What the AI Director returns for a script (validated server-side). */
export interface Breakdown {
  title: string
  /** `voice`: how they sound (optional: older or demo breakdowns have none). */
  characters: { name: string; description: string; voice?: string }[]
  /** Optional: older or demo breakdowns have none. */
  places?: { name: string; description: string; blocking?: string; light?: string }[]
  shots: {
    scene: string
    /** A name from `places`, or empty. */
    place?: string
    description: string
    shotType: string
    /** Where the camera stands and looks (StoryShot.view). Only the scene-by-scene pass writes it. */
    view?: string
    /** The first moment as one picture, for the keyframe (StoryShot.frame). Only the scene-by-scene pass writes it. */
    frame?: string
    /** The place's view behind the subject (StoryShot.background). Only the scene-by-scene pass writes it. */
    background?: PlaceView
    /** The last moment as one picture, when the shot needs a set end (StoryShot.endFrame). */
    endFrame?: string
    camera: string
    prompt: string
    durationSeconds: number
    characters: string[]
    /** Characters seen only from behind or in part (an over-the-shoulder's foreground shoulder, hands). Optional: older breakdowns have none. */
    partial?: string[]
    /** Characters in the frame only as an unreadable outline (StoryShot.hiddenIds), by name. Only the scene-by-scene pass writes it. */
    hidden?: string[]
    /**
     * Shots with the same number, one after another, play as one multi-shot clip (up to the target model's limit, from
     * its workflow: 6 shots in 15 s for Kling 3.0); 0 = a shot of its own — always on LTX, which renders shot by shot.
     */
    group?: number
    dialogue: { character: string; text: string }[]
    sfx: string
  }[]
}

export interface BreakdownRequest {
  script: string
  style?: string
  aspect?: string
  characters?: { name: string; description: string; voice?: string }[]
  places?: { name: string; description: string; blocking?: string; light?: string }[]
  targetShots?: number
  /** The story's video model: the Director writes for it and keeps groups within its clip (missing or unknown: LTX-2.5). */
  targetModelId?: string
}

export interface BreakdownResponse {
  breakdown: Breakdown
  via: 'anthropic' | 'openrouter' | 'fal' | 'demo'
  model: string
}

/** One shot as the Director writes it. */
export type BreakdownShot = Breakdown['shots'][number]

/** A scene of the outline (validated server-side). */
export interface OutlineScene {
  heading: string
  /** A name from the outline's places, or empty. */
  place: string
  time: string
  light: string
  /** Only when it differs from the place's. */
  blocking: string
  characters: string[]
  summary: string
  /** Its part of the script, cut by the server where the scene's opening words are. */
  script: string
  seconds: number
  continuesPrevious: boolean
}

/** The Director's first pass: the world (cast, places) and the structure (chapters → scenes), no shots yet. */
export interface Outline {
  title: string
  logline: string
  characters: { name: string; description: string; voice?: string }[]
  places: { name: string; description: string; blocking?: string; light?: string }[]
  chapters: { title: string; summary: string; scenes: OutlineScene[] }[]
}

export type OutlineRequest = Omit<BreakdownRequest, 'targetShots'>

export interface OutlineResponse {
  outline: Outline
  via: BreakdownResponse['via']
  model: string
}

/** The Director's second pass: the shots of one scene, from its part of the script, with the cast and place as set. */
export interface SceneShotsRequest {
  /** The scene's part of the script (else its summary is used). */
  script: string
  style?: string
  aspect?: string
  targetModelId?: string
  targetShots?: number
  scene: { heading: string; summary?: string; time?: string; light?: string; blocking?: string; continuesPrevious?: boolean }
  /** Where it happens: its look and geography, blocking, light, and what each reference photo shows. */
  place?: { name: string; description: string; blocking?: string; light?: string; photos?: string[]; views?: PlaceView[] }
  /** The cast as set in Cast & Places (the scene's, else everyone). */
  characters: { name: string; description: string; voice?: string }[]
  /** The scene before: how it ends, so this one follows on. */
  previous?: { heading: string; summary?: string; samePlace: boolean; lastShot?: { shotType?: string; description: string; prompt: string } }
  /** The scene after: what this one leads into. */
  next?: { heading: string; summary?: string }
}

/** "Improve with AI" in the look designer: a hero's or a place's description, written the way the scenes read it. */
export interface ImproveLookRequest {
  kind: 'character' | 'place'
  name: string
  description: string
  style?: string
  /** The story, for context. */
  script?: string
}
export interface ImproveLookResponse {
  description: string
  via: BreakdownResponse['via']
  model: string
}

/**
 * One of a place's other directions, written out from its look and geography before it is drawn: told only to turn
 * the camera, both image models redrew the main view (By the Lake, left view).
 */
export interface PlaceViewRequest {
  name: string
  description: string
  light?: string
  view: Exclude<PlaceView, 'main'>
  style?: string
}
export interface PlaceViewResponse {
  /** What the camera sees that way, foreground to background, left to right. */
  description: string
  via: BreakdownResponse['via']
  model: string
}

/** An idea → a short screenplay (headings, action, NAME: lines) the outline reads. */
export interface WriteScriptRequest {
  idea: string
  style?: string
  aspect?: string
}
export interface WriteScriptResponse {
  title: string
  script: string
  via: BreakdownResponse['via']
  model: string
}

/**
 * A picture made in the look designer: a candidate for the main picture (no `angle`) or another angle of the approved
 * one ("back", "reverse"…). Approving copies the chosen ones into the references.
 */
export interface DesignTake {
  generationId: string
  angle?: string
  /**
   * A quick look (the Cast's Create looks): once drawn it becomes the main picture by itself, when there is none yet.
   * Cleared when it is done or failed, so a front view removed later isn't put back.
   */
  auto?: boolean
}

export interface SceneShotsResponse {
  shots: BreakdownShot[]
  via: BreakdownResponse['via']
  model: string
}
