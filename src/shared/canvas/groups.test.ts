import { describe, expect, it } from 'vitest'
import { type CanvasItem, sanitizeCanvas } from '../types/canvas'
import { withFrameContents } from './geometry'
import { ancestorGroups, fitGroups, groupMembers, pickTarget, turnedBounds } from './groups'

const rect = (id: string, x: number, y: number, more: Partial<CanvasItem> = {}): CanvasItem => ({ id, kind: 'shape', shape: 'rect', fill: '#fff', x, y, w: 10, h: 10, ...more }) as CanvasItem

describe('groups', () => {
  const items = (): CanvasItem[] => [
    rect('a', 0, 0, { groupId: 'g' }),
    rect('b', 100, 50, { groupId: 'inner' }),
    rect('c', 200, 200, { groupId: 'inner' }),
    { id: 'inner', kind: 'group', x: 0, y: 0, w: 1, h: 1, groupId: 'g' },
    { id: 'g', kind: 'group', x: 0, y: 0, w: 1, h: 1 },
    rect('loose', 500, 500),
  ]

  it('fits every group to its members, inner groups first', () => {
    const list = fitGroups(items())
    const by = new Map(list.map((i) => [i.id, i]))
    expect(by.get('inner')).toMatchObject({ x: 100, y: 50, w: 110, h: 160 })
    expect(by.get('g')).toMatchObject({ x: 0, y: 0, w: 210, h: 210 })
  })

  it('drops empty groups and members of missing ones', () => {
    const list = fitGroups([rect('a', 0, 0, { groupId: 'gone' }), { id: 'empty', kind: 'group', x: 0, y: 0, w: 1, h: 1 }, { id: 'outer', kind: 'group', x: 0, y: 0, w: 1, h: 1 }, { id: 'mid', kind: 'group', x: 0, y: 0, w: 1, h: 1, groupId: 'outer' }])
    expect(list.map((i) => i.id)).toEqual(['a'])
    expect(list[0]).not.toHaveProperty('groupId')
  })

  it('a click picks the outermost group, or the member of the entered group', () => {
    const by = new Map(fitGroups(items()).map((i) => [i.id, i]))
    expect(pickTarget(by, by.get('b')!).id).toBe('g')
    expect(pickTarget(by, by.get('b')!, 'g').id).toBe('inner')
    expect(pickTarget(by, by.get('b')!, 'inner').id).toBe('b')
    expect(pickTarget(by, by.get('loose')!, 'g').id).toBe('loose')
    expect(ancestorGroups(by, by.get('c')!).map((g) => g.id)).toEqual(['inner', 'g'])
  })

  it('moves, copies and deletes with all of its members', () => {
    const list = fitGroups(items())
    expect([...withFrameContents(list, ['g'])].sort()).toEqual(['a', 'b', 'c', 'g', 'inner'])
    expect(groupMembers(list, 'inner').map((i) => i.id)).toEqual(['b', 'c'])
  })

  it('bounds of a turned box', () => {
    expect(turnedBounds({ x: 0, y: 0, w: 20, h: 10, rotation: 90 })).toEqual({ x: expect.closeTo(5, 6), y: expect.closeTo(-5, 6), w: expect.closeTo(10, 6), h: expect.closeTo(20, 6) })
  })

  it('sanitizing a board fits its groups', () => {
    const doc = sanitizeCanvas({ boards: [{ id: 'B', name: 'B', items: items() }] })!
    expect(doc.boards[0]!.items.find((i) => i.id === 'g')).toMatchObject({ w: 210, h: 210 })
  })
})
