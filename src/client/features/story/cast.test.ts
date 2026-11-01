import type { StoryCharacter, StoryShot } from '@shared/types/story'
import { describe, expect, it } from 'vitest'
import { audioBlock, castLooks, clothesOf, genderOf, lookOf, partialKind, screenSides, shotCast, subjectsPreamble, voiceOf, withSubjects, withoutPictureNotes } from './cast'
import { shotIntros } from './dialects/common'

const tymon: StoryCharacter = { id: 't', name: 'TYMON', description: 'Tymon, a lanky 25-year-old man with a messy crop; olive-green overshirt, white sneakers.' }
const maja: StoryCharacter = { id: 'm', name: 'MAJA', description: 'petite, dark fringe; olive bomber jacket' }
const voice: StoryCharacter = { id: 'v', name: 'SPIKER', description: 'Niewidoczny prezenter wiadomości; spokojny głos' }

const shot = (characterIds: string[]): StoryShot => ({ id: 's', description: '', prompt: '', duration: 4, characterIds, dialogue: [], videoGenerationIds: [] })

describe('lookOf', () => {
  it('uses the Cast description, starting with the name', () => {
    expect(lookOf(tymon)).toBe('Tymon, a lanky 25-year-old man with a messy crop; olive-green overshirt, white sneakers')
    expect(lookOf(maja)).toBe('Maja: petite, dark fringe; olive bomber jacket')
  })

  it('keeps who they are when short', () => {
    expect(lookOf(tymon, true)).toBe('Tymon, a lanky 25-year-old man with a messy crop')
    expect(lookOf({ ...maja, description: '' })).toBe('')
  })
})

describe('picture notes in a look', () => {
  // As they were left in the Cast of Impossible Worlds, and rode along into every LTX shot.
  it('drops the notes for drawing the reference picture, as typed', () => {
    expect(withoutPictureNotes('On gray backdround — seen from behind.')).toBe('')
    expect(withoutPictureNotes('Only one shoot on gray background. One shot on gray bg, not shot with him in environment')).toBe('')
    const daniel: StoryCharacter = {
      id: 'd',
      name: 'Daniel',
      description: 'Daniel, early 40s, tired eyes, stubble; grey wool jumper, dark jeans. On gray backdround — seen from behind.',
    }
    expect(lookOf(daniel)).toBe('Daniel, early 40s, tired eyes, stubble; grey wool jumper, dark jeans')
    const kael: StoryCharacter = {
      id: 'k',
      name: 'Kael',
      description: 'Only one shoot on gray background. Kael, 38, lean man, shaved head; sand-coloured cloak. One shot on gray bg, not shot with him in environment',
    }
    expect(lookOf(kael)).toBe('Kael, 38, lean man, shaved head; sand-coloured cloak')
    expect(lookOf(kael, true)).toBe('Kael, 38, lean man, shaved head')
    // Phrase by phrase: what the person looks like stays in the sentence.
    expect(withoutPictureNotes('Grey jumper, jeans, on a plain white studio backdrop, head to toe.')).toBe('Grey jumper, jeans.')
    expect(withoutPictureNotes('Full figure, facing the camera; no collage, no inset. Red scarf.')).toBe('Red scarf.')
  })

  it('keeps what only sounds like one', () => {
    for (const look of [
      'A leather jacket with quilted panels and inset pockets.',
      'A full-length wool coat, dressed head to toe in black.',
      'Covered in mud from head to toe; a backpack with a side pocket.',
      'Tymon, a lanky 25-year-old man with a messy crop; olive-green overshirt, white sneakers.',
    ]) {
      expect(withoutPictureNotes(look)).toBe(look)
    }
  })
})

describe('castLooks', () => {
  it('describes the visible characters of the shot, in its order, and no one else', () => {
    expect(castLooks(shot(['m', 't']), [tymon, maja])).toBe(
      'Maja: petite, dark fringe; olive bomber jacket. Tymon, a lanky 25-year-old man with a messy crop; olive-green overshirt, white sneakers',
    )
    expect(castLooks(shot([]), [tymon, maja])).toBe('')
  })

  it('leaves out a voice that is never seen', () => {
    expect(castLooks(shot(['v', 't']), [tymon, voice], true)).toBe('Tymon, a lanky 25-year-old man with a messy crop')
  })
})

describe('seen from behind and references', () => {
  it('marks a character seen from behind and leaves out referenced ones', () => {
    const behind: StoryShot = { ...shot(['m']), partialIds: ['t'] }
    expect(castLooks(behind, [tymon, maja], true)).toBe('Maja: petite, dark fringe. Tymon, a lanky 25-year-old man with a messy crop — seen from behind')
    expect(castLooks(behind, [tymon, maja], true, new Map([['t', 'Image 1']]))).toBe('Maja: petite, dark fringe')
  })

  it('a hands-only insert says hands, not from behind (The Chase)', () => {
    const insert: StoryShot = { ...shot([]), partialIds: ['t'], shotType: 'Insert', frame: 'His fingers turn the key' }
    expect(partialKind(insert)).toBe('hands')
    expect(castLooks(insert, [tymon, maja], true)).toBe('Tymon, a lanky 25-year-old man with a messy crop — only the hands and sleeves in the frame')
    expect(shotIntros(insert, [tymon, maja], 'short')).toEqual(['Tymon, a lanky 25-year-old man with a messy crop, only the hands and sleeves in the frame'])
    expect(partialKind({ shotType: 'Close-up', frame: 'Her boots on the wet concrete' })).toBe('feet')
    expect(partialKind({ shotType: 'Insert', frame: 'The phone buzzes on the seat' })).toBe('hands')
    // An over-the-shoulder is from behind, whatever the hands in front of it do; a plain partial too.
    expect(partialKind({ shotType: 'Over-the-shoulder medium', frame: 'Maja holds the phone in both hands' })).toBe('back')
    expect(partialKind({ shotType: 'Medium' })).toBe('back')
  })

  it('someone only an outline in the dark is not in the shot’s cast: no reference, no lip sync — only their clothes', () => {
    expect(shotCast({ ...shot(['m']), partialIds: ['t'], hiddenIds: ['t'] })).toEqual(['m'])
    expect(castLooks({ ...shot(['m']), hiddenIds: ['t'] }, [tymon, maja])).toBe('Maja: petite, dark fringe; olive bomber jacket')
    expect(clothesOf(tymon)).toBe('olive-green overshirt, white sneakers')
    expect(clothesOf({ ...tymon, description: 'Tymon, tall' })).toBe('')
  })

  it('names referenced characters by their image in shot text, whole words only', () => {
    const subjects = new Map([['t', 'Image 1'], ['m', 'Image 2']])
    expect(withSubjects("Over Maja's shoulder: Tymon smiles at Majaland.", [tymon, maja], subjects)).toBe("Over Image 2's shoulder: Image 1 smiles at Majaland.")
    // Names of several words or with inner capitals, entered as written or in capitals.
    const ewa: StoryCharacter = { id: 'e', name: 'PANI EWA', description: '' }
    const jl: StoryCharacter = { id: 'j', name: 'Jean-Luc', description: '' }
    const more = new Map([['e', 'Image 1'], ['j', 'Image 2']])
    expect(withSubjects('Pani Ewa turns to Jean-Luc; Jean-Luc nods.', [ewa, jl], more)).toBe('Image 1 turns to Image 2; Image 2 nods.')
    expect(subjectsPreamble([tymon, maja], subjects)).toBe(
      'Image 1: Tymon, a lanky 25-year-old man with a messy crop; olive-green overshirt, white sneakers. Image 2: Maja: petite, dark fringe; olive bomber jacket',
    )
  })
})

describe('screenSides', () => {
  const valentina: StoryCharacter = { id: 'v', name: 'VALENTINA', description: 'Valentina, a 28-year-old Mexican woman' }
  const mateo: StoryCharacter = { id: 'm', name: 'MATEO', description: 'Mateo, a tall 32-year-old Mexican man' }

  it('reads who stands where, a side said outright winning over "facing right"', () => {
    const blocking =
      'Valentina on the left of the frame by the stone fountain, facing right toward Mateo, the glowing glass doors behind her; Mateo on the right under the arched colonnade, facing left toward her'
    expect(Object.fromEntries(screenSides(blocking, [valentina, mateo]))).toEqual({ v: 'left', m: 'right' })
  })

  it('falls back to a bare side, reads Polish, and leaves out whoever it does not place', () => {
    expect(Object.fromEntries(screenSides('Mateo stands left, looking at the door', [valentina, mateo]))).toEqual({ m: 'left' })
    expect(Object.fromEntries(screenSides('Tymon po prawej przy automacie', [tymon, maja]))).toEqual({ t: 'right' })
    expect(screenSides(undefined, [tymon]).size).toBe(0)
  })

  it('reads lewy/prawy forms but not words that merely start like them ("prawie", "prawda")', () => {
    expect(Object.fromEntries(screenSides('Maja stoi prawie przy drzwiach', [tymon, maja]))).toEqual({})
    expect(Object.fromEntries(screenSides('Tymon, to prawda, czeka', [tymon, maja]))).toEqual({})
    expect(Object.fromEntries(screenSides('Maja, lewa strona kadru', [tymon, maja]))).toEqual({ m: 'left' })
  })
})

describe('voices', () => {
  const valentina: StoryCharacter = { id: 'v', name: 'VALENTINA', description: 'Valentina, a 28-year-old Mexican woman with long dark hair; a red gown' }
  const mateo: StoryCharacter = { id: 'm', name: 'MATEO', description: 'Mateo, a tall 32-year-old Mexican man; a white linen shirt' }

  it('tells the gender from who the character is, "woman" never read as "man"', () => {
    expect(genderOf(valentina)).toBe('female')
    expect(genderOf(mateo)).toBe('male')
    expect(genderOf({ ...maja, description: 'Maja, kobieta po trzydziestce' })).toBe('female')
    expect(genderOf(maja)).toBeUndefined()
  })

  it('says how they sound: the Cast\u2019s Voice, else the gender', () => {
    expect(voiceOf(valentina)).toBe('a female voice')
    expect(voiceOf({ ...valentina, voice: 'Warm, low female voice that trembles but holds.' })).toBe('a warm, low female voice that trembles but holds')
    expect(voiceOf({ ...mateo, voice: 'deep and quiet' })).toBe('a deep and quiet voice')
    expect(voiceOf({ ...mateo, voice: 'an old man\u2019s rasp' })).toBe('an old man\u2019s rasp voice')
    expect(voiceOf(maja)).toBeUndefined()
  })

  it('writes Licon\u2019s voice-sample block with the gender', () => {
    expect(audioBlock('Audio 1', valentina, 'Image 1')).toBe('Audio 1: Female voice, belongs only to Image 1')
    expect(audioBlock('Audio 2', { ...mateo, voice: 'a deep, quiet male voice' }, 'Image 2')).toBe('Audio 2: Deep, quiet male voice, belongs only to Image 2')
    expect(audioBlock('Audio 1', maja, 'Image 1')).toBe('Audio 1: the voice of Image 1, belongs only to Image 1')
  })
})
