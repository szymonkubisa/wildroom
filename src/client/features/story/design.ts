/**
 * The look designer's pictures, pure: what a hero's or a place's candidates and other angles are asked for. A hero is
 * drawn alone on plain grey — a reference with scenery behind the face gets copied into the clips — a place empty, at
 * eye level; other angles are drawn from the approved picture.
 */

export type DesignKind = 'character' | 'place'

export interface DesignAngle {
  id: string
  label: string
  /** How the image model is told the view. */
  phrase: string
  /** What the picture shows, for a place's photo note ("the reverse view"). */
  note: string
}

export const CHARACTER_ANGLES: readonly DesignAngle[] = [
  { id: 'side', label: 'Side', phrase: 'seen in profile, from the side', note: 'in profile' },
  { id: 'three-quarter', label: '¾ view', phrase: 'turned three-quarters away from the camera', note: 'three-quarter view' },
  { id: 'back', label: 'Back', phrase: 'seen from behind: the back of the head, the hair and the clothes from behind', note: 'from behind' },
  { id: 'full', label: 'Full body', phrase: 'the full figure from head to toe, facing the camera', note: 'full figure' },
]

export const PLACE_ANGLES: readonly DesignAngle[] = [
  { id: 'reverse', label: 'Reverse', phrase: 'the reverse view, looking back the opposite way, toward where the camera of the reference image stands', note: 'the reverse view' },
  { id: 'left', label: 'Left', phrase: 'the view turned 90° to the left of the reference view', note: 'the view to the left' },
  { id: 'right', label: 'Right', phrase: 'the view turned 90° to the right of the reference view', note: 'the view to the right' },
  { id: 'detail', label: 'Detail', phrase: 'a closer view of its main feature', note: 'a closer detail' },
]

export const anglesFor = (kind: DesignKind) => (kind === 'character' ? CHARACTER_ANGLES : PLACE_ANGLES)
export const angleOf = (kind: DesignKind, id: string | undefined) => anglesFor(kind).find((a) => a.id === id)

const clause = (text: string | undefined) => text?.trim().replace(/[.\s]+$/, '')

/** What says how a picture is rendered: the medium, the film, the grain — not what is in it. */
const RENDERING = /photo|film|grain|texture|cinema|cinematic|anime|cartoon|illustrat|paint|watercolou?r|sketch|\b3d\b|cgi|render|clay|stop-motion|pixel|noir|black and white|monochrome|sepia|vintage|retro|analog|\d+\s?mm\b|kodak|portra|polaroid|vhs|grade/i
/** …and what puts something in the picture or sets its frame. */
const SCENERY = /sky|desert|planet|horizon|landscape|city|forest|ocean|sea\b|mountain|street|scale|haze|fog|mist|light|sun|camera|crane|drone|framing|composition|\d+:\d+|wide|shot\b|lens|background|^no\b|without/i

/**
 * The film's style as far as a hero's reference photo takes it: how the picture is rendered (photorealistic, 65mm film
 * grain, anime, watercolour…), never what is in it or how it is framed. The whole style ("…ochre and rust desert under
 * a pale violet sky, three giant planets on the horizon… horizontal 16:9 framing") drew Kael twice in one picture — on
 * grey, and again in the desert below — whatever his look said.
 */
export function renderingStyle(style: string): string {
  return style
    .replace(/\.\s*$/, '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part && RENDERING.test(part) && !SCENERY.test(part))
    .join(', ')
}

/** A place's other directions: how the camera turns, and what then moves where in the picture. */
const TURNS: Record<string, { turn: string; shift: string }> = {
  reverse: {
    turn: 'turned all the way round, facing back toward where the reference camera stood',
    shift: 'What was behind the reference camera fills this picture; what filled the reference picture is now behind this camera, out of sight',
  },
  left: {
    turn: 'turned 90° to the left',
    shift: 'What was at the left edge of the reference picture is now in the middle of this one; what was in its middle is now at the right edge, or out of frame',
  },
  right: {
    turn: 'turned 90° to the right',
    shift: 'What was at the right edge of the reference picture is now in the middle of this one; what was in its middle is now at the left edge, or out of frame',
  },
}

/**
 * A candidate for the main picture (no `angle`), or another angle of the approved one (sent along as the reference).
 * `view`: a place's other direction written out (the Director's place-view) — what this picture shows. The subject's
 * picture notes ("full body, arms crossed") go last: they are for these pictures only, never a shot's or a clip's.
 */
export function designPrompt(
  kind: DesignKind,
  subject: { name: string; description: string; light?: string; pictureNotes?: string },
  style: string,
  angle?: DesignAngle,
  view?: string,
): string {
  const notes = clause(subject.pictureNotes)
  const withNotes = (prompt: string) => (notes ? `${prompt} ${notes.charAt(0).toUpperCase()}${notes.slice(1)}.` : prompt)
  return withNotes(drawingPrompt(kind, subject, style, angle, view))
}

function drawingPrompt(kind: DesignKind, subject: { name: string; description: string; light?: string }, style: string, angle?: DesignAngle, view?: string): string {
  const look = clause(subject.description)
  const name = clause(subject.name)
  const film = clause(style)
  if (kind === 'character') {
    if (angle) {
      return `The same person as in the reference image — the same face, hair, build and clothes — ${angle.phrase}, on the same plain light-grey seamless studio background, in the same soft even light; no props, no scenery, no text. Photorealistic.`
    }
    return [
      `Character reference photo of ${look || name}`,
      'Facing the camera, seen from the head to the knees, relaxed neutral expression, arms at the sides, soft even light, plain light-grey seamless studio background, no props, no scenery, no text',
      'One single photograph of one figure — no second panel, no inset, no collage',
      'Photorealistic',
      film && renderingStyle(film),
    ]
      .filter(Boolean)
      .join('. ')
      .concat('.')
  }
  const turning = angle && TURNS[angle.id]
  if (turning) {
    // Told only to turn ("the view turned 90° to the left"), with the main view's layout repeated in the look, GPT Image
    // 2.5 and FLUX 3 both redrew the main view (By the Lake): say what this picture shows, and that the reference is
    // only the place's look.
    return [
      `A photograph of ${name || 'the place'} taken from the same spot as the reference image, with the camera ${turning.turn}`,
      view?.trim() ? `What this view shows: ${clause(view)}` : turning.shift,
      'The reference image only shows what the place looks like — its materials, plants, water, ground, buildings and light — not this view: the composition here is different',
      !view?.trim() && look && `The place as the reference camera sees it: ${look}`,
      'The sun and the light stay where they are in the world, so in this view they fall from another side of the picture',
      'Nobody in the picture, no text',
      'Photorealistic',
    ]
      .filter(Boolean)
      .join('. ')
      .concat('.')
  }
  if (angle) {
    return `The same place as in the reference image — the same buildings, vehicles, objects, materials and light — ${angle.phrase}. Nobody in the picture, no text. Photorealistic.`
  }
  return [`Establishing photograph of ${name ? `${name}: ` : ''}${look || 'the location'}`, `A wide view at eye level, nobody in the picture${subject.light?.trim() ? `, ${clause(subject.light)}` : ''}, no text`, 'Photorealistic', film]
    .filter(Boolean)
    .join('. ')
    .concat('.')
}

// ---- quick picks: the first part of the look, from a few basics

/** A group of quick picks: one word (Who, Age…), or several (`multi`: Face, Wears). */
export interface PickGroup {
  id: string
  label: string
  options: readonly string[]
  multi?: boolean
}

export const CHARACTER_PICKS: readonly PickGroup[] = [
  { id: 'who', label: 'Who', options: ['Man', 'Woman', 'Boy', 'Girl'] },
  { id: 'age', label: 'Age', options: ['Child', 'Teen', '20s', '30s', '40s', '50s', '60s', '70s', '80s+'] },
  { id: 'build', label: 'Build', options: ['Slim', 'Average', 'Athletic', 'Broad', 'Heavy'] },
  { id: 'skin', label: 'Skin', options: ['Fair', 'Light', 'Medium', 'Olive', 'Brown', 'Dark'] },
  { id: 'hair', label: 'Hair', options: ['Blond', 'Brown', 'Black', 'Red', 'Grey', 'White', 'Bald'] },
  { id: 'hairStyle', label: 'Hair style', options: ['Short', 'Messy', 'Long', 'Curly', 'Tied back'] },
  { id: 'face', label: 'Face', multi: true, options: ['Stubble', 'Beard', 'Moustache', 'Freckles', 'Glasses', 'Wrinkles'] },
  { id: 'wears', label: 'Wears', multi: true, options: ['Cap', 'Hoodie', 'Jacket', 'Coat', 'Scarf', 'Boots', 'Uniform'] },
]

export const PLACE_PICKS: readonly PickGroup[] = [
  { id: 'setting', label: 'Setting', options: ['Exterior', 'Interior'] },
  { id: 'place', label: 'Place', options: ['Lake', 'Forest', 'City street', 'Kitchen', 'Desert', 'Beach', 'Mountains'] },
  { id: 'time', label: 'Time', options: ['Dawn', 'Morning', 'Midday', 'Golden hour', 'Dusk', 'Night'] },
  { id: 'weather', label: 'Weather', options: ['Clear', 'Mist', 'Overcast', 'Rain', 'Snow'] },
  { id: 'mood', label: 'Mood', options: ['Calm', 'Warm', 'Eerie', 'Busy', 'Empty'] },
]

export const picksFor = (kind: DesignKind) => (kind === 'character' ? CHARACTER_PICKS : PLACE_PICKS)

export type Picks = Record<string, string | string[]>

const one = (picks: Picks, id: string) => {
  const v = picks[id]
  return typeof v === 'string' ? v : undefined
}
const many = (picks: Picks, id: string) => {
  const v = picks[id]
  return Array.isArray(v) ? v : typeof v === 'string' ? [v] : []
}

/** The picks toggled: a single pick replaces the group's (or clears it, picked again), a multi one joins or leaves it. */
export function togglePick(kind: DesignKind, picks: Picks, groupId: string, value: string): Picks {
  const group = picksFor(kind).find((g) => g.id === groupId)
  const next: Picks = { ...picks }
  if (group?.multi) {
    const list = many(picks, groupId)
    const changed = list.includes(value) ? list.filter((x) => x !== value) : [...list, value]
    if (changed.length) next[groupId] = changed
    else delete next[groupId]
  } else if (one(picks, groupId) === value) delete next[groupId]
  else next[groupId] = value
  return next
}

export const isPicked = (picks: Picks, groupId: string, value: string) => many(picks, groupId).includes(value)

/**
 * The picks as the look's first sentence — "Man, 70s, broad build, light skin, short white hair, stubble, wrinkles,
 * wearing cap, jacket." / "Lake, exterior, dawn, mist, calm mood." — or nothing when none are picked.
 */
export function composeLook(kind: DesignKind, picks: Picks): string {
  const lc = (x: string) => x.toLowerCase()
  const parts: string[] = []
  if (kind === 'character') {
    const who = one(picks, 'who')
    const age = one(picks, 'age')
    const build = one(picks, 'build')
    const skin = one(picks, 'skin')
    const hair = one(picks, 'hair')
    const style = one(picks, 'hairStyle')
    if (who) parts.push(who)
    if (age) parts.push(age === 'Child' ? 'child' : age === 'Teen' ? 'teenager' : age)
    if (build) parts.push(`${lc(build)} build`)
    if (skin) parts.push(`${lc(skin)} skin`)
    if (hair === 'Bald') parts.push('bald')
    else if (hair || style) parts.push(`${style ? `${lc(style)} ` : ''}${hair ? `${lc(hair)} ` : ''}hair`)
    parts.push(...many(picks, 'face').map(lc))
    const wears = many(picks, 'wears')
    if (wears.length) parts.push(`wearing ${wears.map(lc).join(', ')}`)
  } else {
    const place = one(picks, 'place')
    if (place) parts.push(place)
    for (const id of ['setting', 'time', 'weather']) {
      const v = one(picks, id)
      if (v) parts.push(lc(v))
    }
    const mood = one(picks, 'mood')
    if (mood) parts.push(`${lc(mood)} mood`)
  }
  if (!parts.length) return ''
  const text = parts.join(', ')
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`
}

/**
 * The details the picks don't say: the look without the picks' sentence at its start. A look written another way
 * (edited elsewhere, or by Improve with AI) is all details.
 */
export function lookDetails(kind: DesignKind, picks: Picks, description: string): string {
  const lead = composeLook(kind, picks)
  const text = description.trim()
  return lead && text.startsWith(lead) ? text.slice(lead.length).trim() : text
}

/** The whole look: the picks' sentence, then the details. */
export const joinLook = (kind: DesignKind, picks: Picks, details: string) => [composeLook(kind, picks), details.trim()].filter(Boolean).join(' ')
