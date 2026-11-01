import { describe, expect, it } from 'vitest'
import { layoutTimeline } from './layout'
import { collectSnapPoints, snapFrame } from './snapping'
import { aclip, build, mclip, title } from './test-utils'

describe('collectSnapPoints', () => {
  const a = mclip('A', 100)
  a.transitionOut = { type: 'dissolve', duration: 10 }
  const layout = layoutTimeline(build([a, mclip('B', 50)], [[title('T', 20), 30], [aclip('S', 15), 30, -1]], [['m', 42]]))

  it('returns sorted unique clip edges, markers and the playhead', () => {
    expect(collectSnapPoints(layout, { playhead: 77.4 })).toEqual([0, 30, 42, 45, 50, 77, 90, 100, 140])
  })

  it('skips excluded clips and markers', () => {
    expect(collectSnapPoints(layout, { exclude: new Set(['T', 'm', 'B']) })).toEqual([0, 30, 45, 100])
  })
})

describe('snapFrame', () => {
  const points = [0, 30, 42, 50, 100]

  it('snaps to the nearest point within the threshold', () => {
    expect(snapFrame(47, points, 5)).toEqual({ frame: 50, snapped: true, target: 50 })
    expect(snapFrame(33, points, 5)).toEqual({ frame: 30, snapped: true, target: 30 })
    expect(snapFrame(-3, points, 5)).toEqual({ frame: 0, snapped: true, target: 0 })
    expect(snapFrame(104, points, 5)).toEqual({ frame: 100, snapped: true, target: 100 })
  })

  it('prefers the earlier point on a tie and leaves far frames alone', () => {
    expect(snapFrame(46, points, 5)).toEqual({ frame: 42, snapped: true, target: 42 })
    expect(snapFrame(75, points, 5)).toEqual({ frame: 75, snapped: false })
    expect(snapFrame(10, [], 5)).toEqual({ frame: 10, snapped: false })
  })
})
