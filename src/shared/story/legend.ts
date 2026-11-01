/**
 * The legend after an image prompt that tells the model which reference picture is which (a person, a place, an
 * earlier keyframe…) and which one wins where they disagree. Shared: the storyboard's stills and the Composer's
 * @mentions both write it.
 */

export interface KeyframeRef {
  id: string
  /**
   * 'continuity': an earlier keyframe of the same scene, for its layout. 'start': the shot's own keyframe, for drawing
   * its end frame. 'previousEnd': the end frame of the shot before, for drawing this one's keyframe on that moment.
   * 'previs': the first frame of the shot's Blender previs (a grey box with one colour per person), for its camera and
   * blocking — drawn over, never copied.
   */
  kind: 'character' | 'place' | 'frame' | 'continuity' | 'start' | 'previousEnd' | 'previs'
  /** How the prompt names the image ("Maja", "the location “Peron”"). */
  label: string
  /** The character a 'character' reference shows. */
  characterId?: string
  /** A 'place' photo of the direction this shot looks in: what is behind the people, not just what the place looks like. */
  behind?: boolean
  /** A 'start' reference of a shot whose camera doesn't move: its end frame keeps the same framing. */
  still?: boolean
  /** The shot a still of the story shows (continuity, start, previousEnd, frame): its people may leak in (castLine). */
  shotId?: string
  /** A 'previs' reference: who each coloured figure is ("the blue figure is Maja, the green figure is Daniel"). */
  figures?: string
}

const listed = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}` : (xs[0] ?? ''))
const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/**
 * Tells the image model which reference is which, so a place photo isn't taken for a person (or the other way round),
 * and which one wins: the photos over the words (a prompt that says "a grey ticket machine" otherwise beats a photo
 * of a blue one), and the scene's earlier keyframe over the place's photos for where things stand — one order, not
 * two instructions that pull apart.
 */
export function referenceLegend(refs: readonly KeyframeRef[]): string {
  if (!refs.length) return ''
  const list = refs.map((r, i) => `image ${i + 1} is ${r.label}`).join('; ')
  const at = (kind: KeyframeRef['kind']) => refs.flatMap((r, i) => (r.kind === kind ? [`image ${i + 1}`] : []))
  const people = at('character')
  const places = at('place')
  const [scene, ...earlier] = at('continuity')
  const [start] = at('start')
  const [previousEnd] = at('previousEnd')
  const backdrop = refs.flatMap((r, i) => (r.kind === 'place' && r.behind ? [`image ${i + 1}`] : []))
  const rules: string[] = []
  // The shot's Blender previs: its camera and blocking, drawn over in the story's look. Without "never the figures",
  // a mannequin head the keyframe didn't explain came out as a literal purple ball (live test, 2026-10-26).
  const previsIndex = refs.findIndex((r) => r.kind === 'previs')
  if (previsIndex >= 0) {
    const previs = `image ${previsIndex + 1}`
    const figures = refs[previsIndex]!.figures
    rules.push(
      `${sentence(previs)} is the blocking of this shot, rendered as a grey box: keep its camera position, angle, lens and framing exactly, and put every person, piece of furniture, wall, door and window where it is there. Each coloured figure is a person${figures ? ` — ${figures}` : ''}; draw real people, real materials and real light, never the figures, their flat colours or the grey surfaces themselves.`,
    )
  }
  // An end frame drawn from its shot's first frame; a keyframe drawn on the moment the shot before ended.
  const startRef = refs.find((r) => r.kind === 'start')
  if (start) {
    // What the end moves goes from where it was: The Chase's end frames kept the phone on the floor and put a second
    // one in her hand.
    const moved = `anything it moves, opens or removes is no longer where it was in ${start}, and no copy of it stays there`
    rules.push(
      startRef?.still
        ? // A locked-off shot whose end frame changed framing (an insert of the boots → a wide from behind) was morphed between the two.
          `${sentence(start)} is the first frame of this shot — the same camera: keep its framing, lens, place, light and looks exactly; change only what this description says — ${moved}.`
        : `${sentence(start)} is the first frame of this shot: keep its place, light and people exactly as there; what has changed and where the camera now stands come from this description — ${moved}.`,
    )
  }
  if (previousEnd) {
    // The state of things, never the picture: drawn from it keyframe after keyframe, The Chase's piled up its artefacts
    // (the car like glass shards by shot 6) and its framing.
    const look = scene ?? backdrop[0] ?? places[0]
    const from = [look && `the place and objects look as in ${look}`, people.length && 'the people as in their references'].filter(Boolean)
    rules.push(
      `${sentence(previousEnd)} is the previous shot’s last moment from another camera: take only the state things are in now — what moved, opened, broke or appeared — never its framing, angle, lens, textures or grain${from.length ? `; ${from.join(', ')}` : ''}.`,
    )
  }
  if (scene) {
    // Each keyframe is made on its own: without this the set is rearranged from shot to shot.
    rules.push(
      // People keep their places only where the shot doesn't move them: told to copy "where the people are and which way
      // they face", the closing wide kept them apart, facing each other, when it said they stand together facing the smoke.
      `This shot takes place in exactly the scene of ${scene}: the same place and layout — where the buildings, vehicles and objects are and which way they face — and the same light and time of day, seen from the camera position this shot describes, not copying the framing of ${scene}. The people stand and look where this shot says.`,
      // Taken as the picture to redo, the opening keyframe came back almost unchanged — Jan still apart, looking at his
      // phone, when the shot had him holding it up to Hanka (11.10, Transport – scena, scene 2).
      `${sentence(scene)} is an earlier moment of the scene: since then the people have moved — their poses, gestures, gaze and how close they stand come from this description, not from ${scene}.`,
    )
    if (earlier.length) rules.push(sentence(`${listed(earlier)} ${earlier.length > 1 ? 'are other shots' : 'is another shot'} of the same scene, with the same layout.`))
    if (places.length) rules.push(sentence(`${listed(places)} only ${places.length > 1 ? 'show' : 'shows'} what things there look like up close; where ${places.length > 1 ? 'they differ' : 'it differs'} from ${scene}, follow ${scene}.`))
    if (people.length) rules.push(`Take each person’s face, hair and clothes from their own reference (${listed(people)}), not from the earlier shots.`)
  } else {
    const keep = [people.length && 'each person’s face, hair and clothes', places.length && 'the location’s architecture, objects, colours and signage'].filter(Boolean)
    if (keep.length) rules.push(`Keep ${keep.join(' and ')} exactly as in the references.`)
    const views = places.filter((p) => !backdrop.includes(p))
    if (backdrop[0]) {
      rules.push(
        `${sentence(backdrop[0])} is what lies behind the people from this camera: keep it as the backdrop — the same land, water, plants, buildings and light — at this shot’s framing and lens; the people stand in front of it where this shot says.`,
      )
    }
    // A place photo is one view of the place: told to keep its layout, the model puts that view behind every shot —
    // both cars down the road behind a reverse close-up taken from inside one of them.
    if (views.length) {
      rules.push(
        sentence(
          backdrop[0]
            ? `${listed(views)} only ${views.length > 1 ? 'show' : 'shows'} what things there look like up close.`
            : `${listed(views)} ${views.length > 1 ? 'show' : 'shows'} what the place looks like, not this shot’s view: the camera stands where this shot describes and faces that way, so what is behind the subject is what lies in that direction.`,
        ),
      )
    }
  }
  if (scene || start || previousEnd || people.length || places.length) {
    // On looks only: read as "follow the references" in general, it made a later keyframe copy the earlier one's poses.
    rules.push(
      start || previousEnd
        ? 'Where this description and the references differ on how someone looks — faces, hair, clothes — follow the references; what has changed in the place, what the people do and where they are come from this description.'
        : scene
        ? 'Where this description and the references differ on how someone or something looks — faces, hair, clothes, objects — follow the references; what the people do, where they stand and where they look come from this description.'
        : 'Where this description and the references differ on how someone or something looks, follow the references.',
    )
  }
  return `Reference images: ${list}.${rules.length ? ` ${rules.join(' ')}` : ''}`
}

/** The prompt with the legend of its references after it (the prompt alone when nothing goes with it). */
export const withLegend = (prompt: string, refs: readonly KeyframeRef[]) =>
  refs.length ? `${prompt.trim().replace(/[.\s]+$/, '')}. ${referenceLegend(refs)}` : prompt
