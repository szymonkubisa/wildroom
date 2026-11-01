import { describe, expect, it } from 'vitest'
import { CHARACTER_ANGLES, PLACE_ANGLES, angleOf, composeLook, designPrompt, isPicked, joinLook, lookDetails, renderingStyle, togglePick } from './design'

describe('the look designer’s pictures', () => {
  it('draws a hero alone on plain grey, facing the camera, in the film’s style', () => {
    const p = designPrompt('character', { name: 'Jan', description: 'Jan, 40s, lean; grey jacket.' }, '35mm film look.', undefined)
    expect(p).toBe(
      'Character reference photo of Jan, 40s, lean; grey jacket. Facing the camera, seen from the head to the knees, relaxed neutral expression, arms at the sides, soft even light, plain light-grey seamless studio background, no props, no scenery, no text. One single photograph of one figure — no second panel, no inset, no collage. Photorealistic. 35mm film look.',
    )
  })

  it('adds the picture notes, for these pictures only', () => {
    const notes = { name: 'Jan', description: 'Jan, 40s, lean; grey jacket.', pictureNotes: 'full body, hands in pockets.' }
    expect(designPrompt('character', notes, '', undefined).endsWith('Photorealistic. Full body, hands in pockets.')).toBe(true)
    expect(designPrompt('character', notes, '', angleOf('character', 'back')).endsWith('Photorealistic. Full body, hands in pockets.')).toBe(true)
    expect(designPrompt('place', { name: 'Yard', description: 'A muddy yard.', pictureNotes: 'at dawn, no cars' }, '', undefined)).toContain('Photorealistic. At dawn, no cars.')
    expect(designPrompt('character', { ...notes, pictureNotes: '  ' }, '', undefined).endsWith('Photorealistic.')).toBe(true)
  })

  it('takes from the film’s style only how it is rendered — its desert and planets drew the hero twice (Kael)', () => {
    const style =
      'Epic photorealistic science-fiction cinema, vast scale and atmospheric haze, ochre and rust desert under a pale violet sky, three giant planets on the horizon, monumental minimalist compositions, slow sweeping crane and drone camera, 65mm large-format film texture, soft diffused light, horizontal 16:9 framing, no text.'
    expect(renderingStyle(style)).toBe('Epic photorealistic science-fiction cinema, 65mm large-format film texture')
    const p = designPrompt('character', { name: 'Kael', description: 'Kael, 38, lean man; sand-coloured cloak.' }, style, undefined)
    expect(p).not.toMatch(/desert|planet|horizon|16:9|crane/)
    expect(renderingStyle('Hand-drawn anime, cel shading, pastel sky')).toBe('Hand-drawn anime')
  })

  it('draws another angle from the picked picture, keeping the person and the background', () => {
    const back = angleOf('character', 'back')!
    const p = designPrompt('character', { name: 'Jan', description: 'x' }, '', back)
    expect(p).toContain('The same person as in the reference image')
    expect(p).toContain('seen from behind')
    expect(p).toContain('plain light-grey seamless studio background')
  })

  it('draws a place empty at eye level in its light; its angles are other views of the same place', () => {
    const p = designPrompt('place', { name: 'Roadside', description: 'A narrow asphalt road.', light: 'blue hour.' }, '', undefined)
    expect(p).toBe('Establishing photograph of Roadside: A narrow asphalt road. A wide view at eye level, nobody in the picture, blue hour, no text. Photorealistic.')
    expect(designPrompt('place', { name: 'Roadside', description: 'x' }, '', angleOf('place', 'reverse'))).toContain('facing back toward where the reference camera stood')
    // Told only to turn, GPT Image 2.5 and FLUX 3 redrew the main view (By the Lake, left): the written view says what
    // this picture shows, and the reference is only the place's look.
    const lake = { name: 'Lake', description: 'The pier projects from foreground center; dense reeds lie screen left, to the west.' }
    const written = designPrompt('place', lake, '', angleOf('place', 'left'), 'Dense reeds and the curving western shoreline fill the frame; the pier enters at the right edge.')
    expect(written).toContain('with the camera turned 90° to the left')
    expect(written).toContain('What this view shows: Dense reeds and the curving western shoreline fill the frame; the pier enters at the right edge.')
    expect(written).toContain('not this view: the composition here is different')
    expect(written).not.toContain('projects from foreground center')
    // Without the Director: what moves where, and the look as the reference camera sees it.
    const turnOnly = designPrompt('place', lake, '', angleOf('place', 'left'))
    expect(turnOnly).toContain('What was at the left edge of the reference picture is now in the middle of this one')
    expect(turnOnly).toContain('The place as the reference camera sees it: The pier projects')
    expect(turnOnly).toContain('in this view they fall from another side of the picture')
    expect(designPrompt('place', lake, '', angleOf('place', 'detail'))).not.toContain('another side of the picture')
    expect(CHARACTER_ANGLES.map((a) => a.id)).toEqual(['side', 'three-quarter', 'back', 'full'])
    expect(PLACE_ANGLES.map((a) => a.note)).toContain('the reverse view')
  })
})

describe('quick picks', () => {
  const henryk = { who: 'Man', age: '70s', build: 'Broad', skin: 'Light', hair: 'White', hairStyle: 'Short', face: ['Stubble', 'Wrinkles'], wears: ['Cap', 'Jacket'] }

  it('write the look’s first sentence', () => {
    expect(composeLook('character', henryk)).toBe('Man, 70s, broad build, light skin, short white hair, stubble, wrinkles, wearing cap, jacket.')
    expect(composeLook('character', { who: 'Boy', age: 'Child', hair: 'Bald' })).toBe('Boy, child, bald.')
    expect(composeLook('place', { setting: 'Exterior', place: 'Lake', time: 'Dawn', weather: 'Mist', mood: 'Calm' })).toBe('Lake, exterior, dawn, mist, calm mood.')
    expect(composeLook('place', {})).toBe('')
  })

  it('toggle: one word per group, or several where the group takes several', () => {
    let p = togglePick('character', {}, 'who', 'Man')
    p = togglePick('character', p, 'who', 'Woman')
    expect(p).toEqual({ who: 'Woman' })
    expect(togglePick('character', p, 'who', 'Woman')).toEqual({})
    p = togglePick('character', p, 'face', 'Glasses')
    p = togglePick('character', p, 'face', 'Freckles')
    expect(p.face).toEqual(['Glasses', 'Freckles'])
    expect(isPicked(p, 'face', 'Freckles')).toBe(true)
    expect(togglePick('character', togglePick('character', p, 'face', 'Glasses'), 'face', 'Freckles')).toEqual({ who: 'Woman' })
  })

  it('the details are what follows the picks; a look written another way is all details', () => {
    const look = joinLook('character', henryk, ' Green fishing jacket, kind eyes. ')
    expect(look).toBe('Man, 70s, broad build, light skin, short white hair, stubble, wrinkles, wearing cap, jacket. Green fishing jacket, kind eyes.')
    expect(lookDetails('character', henryk, look)).toBe('Green fishing jacket, kind eyes.')
    expect(lookDetails('character', henryk, 'An old fisherman.')).toBe('An old fisherman.')
    expect(joinLook('place', {}, 'A jetty.')).toBe('A jetty.')
  })
})
