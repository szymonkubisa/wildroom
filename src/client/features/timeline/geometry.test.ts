import type { TimelineLayout } from '@shared/timeline'
import { describe, expect, it } from 'vitest'
import { audioBand, buildRows, dbToPos, laneSpan, posToDb, tickSteps } from './geometry'

describe('timeline geometry', () => {
  it('maps dB to band position and back', () => {
    expect(dbToPos(-60)).toBe(0)
    expect(dbToPos(12)).toBe(1)
    expect(dbToPos(-30)).toBeCloseTo(0.25)
    for (const db of [-48, -30, -12, -6, 0, 3, 12]) expect(posToDb(dbToPos(db))).toBeCloseTo(db, 0)
    // 0 dB sits in the upper part of the band so there is room to boost and cut
    expect(dbToPos(0)).toBeGreaterThan(0.7)
    expect(dbToPos(0)).toBeLessThan(0.85)
  })

  it('gives audio-only clips the whole body and video clips a bottom strip', () => {
    expect(audioBand(40, true)).toEqual({ top: 16, height: 22 })
    const strip = audioBand(68, false)
    expect(strip.top + strip.height).toBe(68)
    expect(strip.height).toBeGreaterThanOrEqual(16)
  })

  it('keeps ruler majors at least ~90 px apart', () => {
    for (const ppf of [0.05, 0.5, 2, 10, 40]) {
      const { major, minor } = tickSteps(ppf, 24)
      expect(major * ppf).toBeGreaterThanOrEqual(90 - 1e-9)
      expect(major % minor).toBe(0)
    }
  })
})

describe('timeline rows', () => {
  const withLanes = (...lanes: number[]) => ({ connected: lanes.map((lane) => ({ lane })) }) as unknown as TimelineLayout
  const lanesOf = (rows: { lane: number }[]) => rows.map((r) => r.lane)

  it('keeps one empty lane above and below as a drop target', () => {
    expect(lanesOf(buildRows(withLanes()).rows)).toEqual([1, 0, -1])
    expect(lanesOf(buildRows(withLanes(1, 2, -1)).rows)).toEqual([3, 2, 1, 0, -1, -2])
  })

  it('holds the rows of the drag start while a clip is dragged, so they don’t shift under the pointer', () => {
    const before = laneSpan(withLanes())
    // The storyline clip now sits on lane 1: no new lane 2 appears on top.
    expect(lanesOf(buildRows(withLanes(1), before).rows)).toEqual([1, 0, -1])
    // A lane already in use stays even if the dragged clip leaves it.
    expect(lanesOf(buildRows(withLanes(), laneSpan(withLanes(2))).rows)).toEqual([3, 2, 1, 0, -1])
  })
})
