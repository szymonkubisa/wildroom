import type { ModelSpec } from '@shared/models/types'
import type { StoryCharacter, StoryShot } from '@shared/types/story'
import { describe, expect, it } from 'vitest'
import { getModel } from '@shared/models/registry'
import { linePhrases, looksEnglish, soundtrackPrompt, speaksAudio, storyLanguage } from './soundtrack'

const jan: StoryCharacter = { id: 'j', name: 'JAN', description: 'Jan Różalski, 44 lata, szczupły prokurator wojskowy; krótkie ciemne włosy' }
const hanka: StoryCharacter = { id: 'h', name: 'HANKA', description: 'Żona Jana, około 40 lat; ciemnoblond kucyk' }

const shot = (extra: Partial<StoryShot>): StoryShot => ({
  id: 's',
  description: '',
  prompt: 'x',
  duration: 6,
  characterIds: ['j'],
  dialogue: [],
  videoGenerationIds: [],
  ...extra,
})

describe('soundtrackPrompt', () => {
  it('writes the line as narration — speaker by look, delivery, language, exact words — not as a script label', () => {
    const text = soundtrackPrompt(shot({ dialogue: [{ id: '1', characterId: 'j', text: '[pod nosem, z przekąsem] Jak zwykle tylko modły dobrze słychać.' }] }), [jan])
    expect(text).toBe(
      'Jan Różalski, 44 lata, szczupły prokurator wojskowy says in Polish, pod nosem, z przekąsem, "Jak zwykle tylko modły dobrze słychać.", lips moving with the words.',
    )
    expect(text).not.toMatch(/JAN \(|Dialogue:/)
  })

  it('restates each speaker verbatim, voices an absent one off-screen, and ends with the sounds', () => {
    const text = soundtrackPrompt(
      shot({
        dialogue: [
          { id: '1', characterId: 'h', text: 'Daję radę.' },
          { id: '2', characterId: 'j', text: 'Dobrze.' },
          { id: '3', characterId: 'j', text: 'Jedziemy.' },
        ],
        sfx: 'Warkot śmigłowców.',
      }),
      [jan, hanka],
    )
    expect(text).toContain('Hanka, żona Jana, około 40 lat is heard off-screen saying in Polish, in a natural, conversational voice, "Daję radę."')
    expect(text).toContain('Jan Różalski, 44 lata, szczupły prokurator wojskowy says in Polish, in a natural, conversational voice, "Jedziemy.", lips moving')
    expect(text.endsWith('Ambient sound: warkot śmigłowców.')).toBe(true)
    expect(text).not.toContain('."."')
    expect(soundtrackPrompt(shot({ sfx: 'wiatr' }), [jan], { sound: false })).toBe('')
    // "We hear the platform ambience continues" was no sentence.
    expect(soundtrackPrompt(shot({ sfx: 'The platform ambience continues; a door hisses shut.' }), [jan])).toBe('Ambient sound: the platform ambience continues; a door hisses shut.')
  })

  it('made to the recorded lines (lip sync): the words only — no delivery, no cues between phrases', () => {
    const lines = shot({ characterIds: ['j', 'h'], dialogue: [{ id: '1', characterId: 'j', text: '[pod nosem] No weź. [patrzy na ekran] No weź, weź.' }, { id: '2', characterId: 'j', text: '[sighs]' }] })
    expect(soundtrackPrompt(lines, [jan, hanka], { brief: true, wordsOnly: true })).toBe(
      'Jan says in Polish, "No weź. No weź, weź.", lips moving with the words, while Hanka listens silently with closed lips.',
    )
    // Not lip-synced: the delivery and the cue play.
    expect(soundtrackPrompt(lines, [jan, hanka], { brief: true })).toContain('pod nosem, "No weź.", then patrzy na ekran, "No weź, weź."')
  })

  it('leaves picture notes out of who speaks', () => {
    const daniel: StoryCharacter = { id: 'd', name: 'Daniel', description: 'On gray backdround — seen from behind. Daniel, 40s, tired eyes; grey jumper' }
    const text = soundtrackPrompt(shot({ characterIds: ['d'], dialogue: [{ id: '1', characterId: 'd', text: 'We leave now.' }] }), [daniel])
    expect(text.startsWith('Daniel, 40s, tired eyes says in English')).toBe(true)
  })
})

describe('soundtrackPrompt — unseen characters', () => {
  it('voices a character described as never seen off-screen even when linked to the shot', () => {
    const jerzy: StoryCharacter = { id: 'z', name: 'JERZY', description: 'Niewidoczny rozmówca Jana; suchy głos' }
    const text = soundtrackPrompt(
      shot({ characterIds: ['j', 'z'], dialogue: [{ id: '1', characterId: 'z', text: 'Reuters.' }, { id: '2', characterId: 'j', text: 'Co to znaczy?' }] }),
      [jan, jerzy],
    )
    expect(text).toContain('Jerzy, niewidoczny rozmówca Jana is heard off-screen saying, in a natural, conversational voice, "Reuters."')
    expect(text).toContain('says, in a natural, conversational voice, "Co to znaczy?", lips moving')
  })
})

describe('speaksAudio', () => {
  const model = (id: string) => getModel(id) as ModelSpec
  it('is true for video models that generate their own audio', () => {
    expect(speaksAudio(model('local-ltx-2.5'))).toBe(true)
    expect(speaksAudio(model('local-flux-2'))).toBe(false)
  })

  it('follows the render settings: the audio switch, its default, and whether it is offered at all', () => {
    expect(speaksAudio(model('local-ltx-2.5'), { audio: false })).toBe(false)
    // Kling O3 on fal renders silent unless audio is switched on.
    expect(speaksAudio(model('fal-kling-o3'))).toBe(false)
    expect(speaksAudio(model('fal-kling-o3'), { audio: true })).toBe(true)
    // Kling 2.6 offers audio only at 1080p.
    expect(speaksAudio(model('kling-2.6'), { resolution: '1080p' })).toBe(true)
    expect(speaksAudio(model('kling-2.6'), { resolution: '720p' })).toBe(false)
  })

  it('takes the catalog’s word for models that always make sound and have no switch', () => {
    expect(speaksAudio(model('kling-3.0-turbo'))).toBe(true)
    expect(speaksAudio(model('fal-happy-horse-1.1'))).toBe(true)
    expect(speaksAudio(model('kling-2.5-turbo'))).toBe(false)
  })
})

describe('soundtrackPrompt — insert shots', () => {
  it('voices the speaker of an insert (hands, objects) off-screen even when they are in the shot', () => {
    const text = soundtrackPrompt(shot({ shotType: 'INSERT CLOSE-UP', dialogue: [{ id: '1', characterId: 'j', text: 'Delikatnie.' }] }), [jan])
    expect(text).toContain('is heard off-screen saying, in a natural, conversational voice, "Delikatnie."')
    expect(text).not.toContain('lips moving')
  })
})

describe('soundtrackPrompt — delivery, from behind, references', () => {
  it('asks for a natural voice unless the line says how', () => {
    expect(soundtrackPrompt(shot({ dialogue: [{ id: '1', characterId: 'j', text: 'Czy tylko modlitwy?' }] }), [jan])).toContain(
      'says, in a natural, conversational voice, "Czy tylko modlitwy?"',
    )
    expect(soundtrackPrompt(shot({ dialogue: [{ id: '1', characterId: 'j', text: '[shouting] Stój!' }] }), [jan])).toContain('says in Polish, shouting, "Stój!"')
  })

  it('voices someone seen from behind without lip sync', () => {
    const text = soundtrackPrompt(shot({ characterIds: ['h'], partialIds: ['j'], dialogue: [{ id: '1', characterId: 'j', text: 'Gdzie?' }] }), [jan, hanka])
    expect(text).toContain('Jan Różalski, 44 lata, szczupły prokurator wojskowy is heard saying')
    expect(text).not.toContain('lips moving')
  })

  it('names a referenced speaker the way the model knows them', () => {
    const text = soundtrackPrompt(shot({ dialogue: [{ id: '1', characterId: 'j', text: 'Dobrze.' }] }), [jan], { subjects: new Map([['j', 'Image 1']]) })
    expect(text).toBe('Image 1 speaks with visible lip movement, in a natural, conversational voice: "Dobrze."')
  })

  it('keeps everyone else in the frame quiet, so the line goes to the right face', () => {
    const text = soundtrackPrompt(shot({ characterIds: ['j'], partialIds: ['h'], dialogue: [{ id: '1', characterId: 'j', text: 'Dobrze.' }] }), [jan, hanka])
    expect(text).toContain('lips moving with the words, while Hanka listens silently with closed lips.')
  })

  it('uses the story’s language for a line too short to tell', () => {
    const text = soundtrackPrompt(shot({ dialogue: [{ id: '1', characterId: 'j', text: 'Jak konia.' }] }), [jan], { language: 'Polish' })
    expect(text).toContain('says in Polish,')
    expect(storyLanguage({ shots: [shot({ dialogue: [{ id: '1', text: 'Dzień dobry, pani Tereso.' }] })] })).toBe('Polish')
    expect(storyLanguage({ shots: [shot({ dialogue: [{ id: '1', text: 'Hello.' }] })] })).toBeUndefined()
  })
})

describe('phrases and acting cues', () => {
  it('splits a line into phrases with the cues between them', () => {
    expect(linePhrases('[pod nosem] No weź. [patrzy na ekran] No weź, weź.')).toEqual({
      delivery: 'pod nosem',
      parts: [{ words: 'No weź.' }, { cue: 'patrzy na ekran', words: 'No weź, weź.' }],
    })
    expect(linePhrases('Dobrze. [nods]').parts).toEqual([{ words: 'Dobrze.' }, { cue: 'nods', words: '' }])
  })

  it('voices each phrase in quotes with the cue between them', () => {
    const text = soundtrackPrompt(shot({ dialogue: [{ id: '1', characterId: 'j', text: 'Przyjmuje. [taps the machine] Jak chce.' }] }), [jan], { language: 'Polish' })
    expect(text).toContain('says in Polish, in a natural, conversational voice, "Przyjmuje.", then taps the machine, "Jak chce.", lips moving with the words.')
  })
})

describe('spoken language', () => {
  it('names English only when the lines read as English, never for Polish written without diacritics', () => {
    expect(looksEnglish(["I'm getting married tomorrow.", 'Five years, Valentina.'])).toBe(true)
    expect(looksEnglish(['Dobrze.', 'Co to znaczy?', 'Reuters.', 'Czy tylko modlitwy?'])).toBe(false)
    expect(looksEnglish(['Mateo…'])).toBe(false)
    expect(storyLanguage({ shots: [shot({ dialogue: [{ id: '1', text: "[softly] You can't be here." }] })] })).toBe('English')
    expect(storyLanguage({ shots: [shot({ dialogue: [{ id: '1', text: 'Jak konia.' }, { id: '2', text: 'Zostań ze mną.' }] })] })).toBe('Polish')
    expect(storyLanguage({ shots: [shot({ dialogue: [{ id: '1', text: 'Dobrze.' }] })] })).toBeUndefined()
  })
})
