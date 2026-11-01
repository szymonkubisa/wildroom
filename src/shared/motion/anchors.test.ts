import { describe, expect, it } from 'vitest'
import { layoutTimeline } from '../timeline/layout'
import { connectedAt, makeDoc, mclip } from '../timeline/test-utils'
import type { AlignedWord } from '../types/assets'
import type { MotionClip } from '../types/project-doc'
import { anchorFrame, anchorShifts, anchoredClip, firstKeyFrame, shiftTrack, unanchorTracks, voiceTimings } from './anchors'
import { sanitizeMotionClip } from './sanitize'

const FPS = 24
const say = (...words: [string, number][]): AlignedWord[] => words.map(([text, start]) => ({ text, start, end: start + 0.3 }))

const motion = (tracks: MotionClip['tracks']): MotionClip => ({ kind: 'motion', id: 'M', duration: 240, enabled: true, boardId: 'B', frameId: 'F', tracks })

describe('keys timed to the voice-over', () => {
  // A 10 s storyline; the voice clip starts at 2 s, its first 0.5 s trimmed off.
  const setup = (words: AlignedWord[]) => {
    const doc = makeDoc([mclip('A', 240)])
    const voice = mclip('V', 120, { asset: 'voice', sourceIn: 12 })
    doc.connected = [connectedAt(doc, voice, 48, -1)]
    const voices = voiceTimings(layoutTimeline(doc), (id) => (id === 'voice' ? words : undefined))
    return voices
  }

  it('finds where words are said on the timeline, the nth time, inside the clip only', () => {
    const voices = setup(say(['Hello', 0.2], ['the', 1], ['drama', 1.5], ['triangle!', 1.8], ['drama', 3]))
    expect(voices.map((v) => [v.clipId, v.start, v.end, v.sourceIn])).toEqual([['V', 48, 168, 0.5]])
    expect(anchorFrame({ text: 'Drama, triangle' }, voices, FPS)).toBe(48 + 24)
    expect(anchorFrame({ text: 'drama', nth: 2 }, voices, FPS)).toBe(48 + 60)
    // "Hello" is in the trimmed-off head.
    expect(anchorFrame({ text: 'hello' }, voices, FPS)).toBeUndefined()
    expect(anchorFrame({ text: 'square' }, voices, FPS)).toBeUndefined()
  })

  it('moves an anchored track onto its words, and again when the voice is recorded anew', () => {
    const track = { opacity: [{ frame: 10, value: 0 }, { frame: 20, value: 1 }], anchor: { text: 'drama', offset: -3 } }
    const clip = motion({ T: track, S: { opacity: [{ frame: 5, value: 0 }] } })
    const first = anchorShifts(clip, 0, setup(say(['drama', 1.5])), FPS)
    expect(first).toEqual({ T: 48 + 24 - 3 - 10 })
    expect(anchoredClip(clip, first).tracks.T!.opacity!.map((k) => k.frame)).toEqual([69, 79])
    // Re-recorded slower: the word comes half a second later, so does the animation.
    const again = anchorShifts(clip, 0, setup(say(['drama', 2])), FPS)
    expect(again.T).toBe(first.T! + 12)
    // A clip starting later on the timeline counts from its own start (and its offset).
    expect(anchorShifts({ ...clip, offset: 6 }, 40, setup(say(['drama', 1.5])), FPS).T).toBe(48 + 24 - 40 + 6 - 3 - 10)
  })

  it('edits made on the shifted keys go back to the stored ones', () => {
    const track = { opacity: [{ frame: 10, value: 0 }], behaviors: [{ kind: 'float' as const, amount: 5, period: 24, from: 12 }], loop: { from: 10, to: 30 } }
    const shifted = shiftTrack(track, 7)
    expect(firstKeyFrame(shifted)).toBe(17)
    expect(shifted.loop).toEqual({ from: 17, to: 37 })
    expect(unanchorTracks({ T: shifted }, { T: 7 }).T).toEqual(track)
  })

  it('keeps its anchor frame when a key is added before it: the earlier key plays before the words', () => {
    const voices = setup(say(['drama', 1.5]))
    const track = { opacity: [{ frame: 30, value: 0 }, { frame: 40, value: 1 }], anchor: { text: 'drama', at: 30 } }
    const before = anchorShifts(motion({ T: track }), 0, voices, FPS).T!
    const earlier = { ...track, opacity: [{ frame: 10, value: 0.5 }, ...track.opacity] }
    expect(anchorShifts(motion({ T: earlier }), 0, voices, FPS).T).toBe(before)
    // Edited as it plays and stored back, the anchor frame comes back with the keys.
    expect(unanchorTracks({ T: shiftTrack(earlier, before) }, { T: before }).T!.anchor).toEqual({ text: 'drama', at: 30 })
  })

  it('keeps a valid anchor through sanitizing', () => {
    const clean = sanitizeMotionClip(motion({ T: { opacity: [{ frame: 0, value: 1 }], anchor: { text: '  drama ', nth: 1, offset: -2.4, clipId: '' } } }))
    // Pinned to its first key (older files have no `at`).
    expect(clean.tracks.T!.anchor).toEqual({ text: 'drama', offset: -2, at: 0 })
    expect(sanitizeMotionClip(motion({ T: { opacity: [{ frame: 0, value: 1 }], anchor: { text: ' ' } } })).tracks.T!.anchor).toBeUndefined()
  })
})
