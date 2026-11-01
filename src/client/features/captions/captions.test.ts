import { describe, expect, it } from 'vitest'
import type { AssetDTO } from '@shared/types/assets'
import type { Scene } from '@/engine/scene'
import { captionCuesFromDialogue, cuesInRange, cuesToSrt, cuesToVtt } from './captions'

const words = (list: [string, number, number][]) => list.map(([text, start, end]) => ({ text, start, end }))

function scene(sourceStart = 0, speed = 1, start = 24): Scene {
  return {
    fps: 24,
    width: 1920,
    height: 1080,
    duration: 480,
    video: [],
    editPoints: [],
    audio: [
      {
        clipId: 'c1',
        assetId: 'voice',
        start,
        end: start + 240,
        sourceStart,
        speed,
        role: 'dialogue',
        audio: { enabled: true, role: 'dialogue', gainDb: 0, pan: 0, fadeIn: 0, fadeOut: 0 },
        transitions: [],
      },
    ],
  }
}

const voice = {
  id: 'voice',
  alignment: {
    words: words([
      ['Did', 0.0, 0.2],
      ['you', 0.25, 0.4],
      ['hear', 0.45, 0.7],
      ['that?', 0.75, 1.1],
      ['It', 2.0, 2.1],
      ['came', 2.15, 2.4],
      ['from', 2.45, 2.6],
      ['the', 2.65, 2.7],
      ['lighthouse.', 2.75, 3.3],
    ]),
  },
} as unknown as AssetDTO

describe('captions', () => {
  it('splits on pauses and places cues on the timeline', () => {
    const cues = captionCuesFromDialogue(scene(), () => voice)
    expect(cues.map((c) => c.text)).toEqual(['Did you hear that?', 'It came from the lighthouse.'])
    expect(cues[0]!.start).toBe(24) // clip starts at 1 s
    expect(cues[1]!.start).toBe(24 + 48) // word at 2.0 s into the clip
  })

  it('follows slips and speed changes', () => {
    const cues = captionCuesFromDialogue(scene(2, 2), () => voice)
    // source 2.0 s is at the clip start; at 2× speed source 3.3 s ends 0.65 s later
    expect(cues).toHaveLength(1)
    expect(cues[0]!.start).toBe(24)
    expect(cues[0]!.text).toBe('It came from the lighthouse.')
  })

  it('writes SRT and VTT', () => {
    const cues = [{ start: 24, end: 60, text: 'Hello' }]
    expect(cuesToSrt(cues, 24)).toBe('1\n00:00:01,000 --> 00:00:02,500\nHello\n')
    expect(cuesToVtt(cues, 24)).toBe('WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nHello\n')
  })

  it('cuts cues to an exported In/Out range, so the SRT never goes below zero', () => {
    const cues = [
      { start: 0, end: 30, text: 'Before' },
      { start: 36, end: 72, text: 'Across the In point' },
      { start: 80, end: 100, text: 'Inside' },
      { start: 110, end: 150, text: 'Across the Out point' },
      { start: 160, end: 180, text: 'After' },
    ]
    const inRange = cuesInRange(cues, 48, 120)
    expect(inRange).toEqual([
      { start: 48, end: 72, text: 'Across the In point' },
      { start: 80, end: 100, text: 'Inside' },
      { start: 110, end: 120, text: 'Across the Out point' },
    ])
    expect(cuesToSrt(inRange, 24, 48).split('\n\n')[0]).toBe('1\n00:00:00,000 --> 00:00:01,000\nAcross the In point')
  })
})
