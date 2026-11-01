import type { CanvasGroupItem, CanvasItem, Rect } from '../types/canvas'

/**
 * Groups on a board: members point at their group with `groupId` (groups can nest); a group's box is kept equal to
 * its members' bounds, so the board, the inspector and the animation can treat it like any element.
 */

/** The groups an item sits in, innermost first. */
export function ancestorGroups(byId: ReadonlyMap<string, CanvasItem>, item: CanvasItem): CanvasGroupItem[] {
  const out: CanvasGroupItem[] = []
  const seen = new Set<string>()
  let id = item.groupId
  while (id && !seen.has(id)) {
    seen.add(id)
    const g = byId.get(id)
    if (g?.kind !== 'group') break
    out.push(g)
    id = g.groupId
  }
  return out
}

/** Everything inside a group, nested groups' members included. */
export function groupMembers(items: readonly CanvasItem[], groupId: string): CanvasItem[] {
  const ids = new Set([groupId])
  let grew = true
  while (grew) {
    grew = false
    for (const i of items)
      if (i.groupId && ids.has(i.groupId) && !ids.has(i.id)) {
        ids.add(i.id)
        grew = true
      }
  }
  ids.delete(groupId)
  return items.filter((i) => ids.has(i.id))
}

/**
 * What a click on `item` picks: its outermost group, or — inside an entered group — the member of that group the item
 * belongs to. Items outside any group are picked as they are.
 */
export function pickTarget(byId: ReadonlyMap<string, CanvasItem>, item: CanvasItem, entered?: string): CanvasItem {
  const chain = [item, ...ancestorGroups(byId, item)]
  if (entered) {
    const at = chain.findIndex((i) => i.id === entered)
    if (at > 0) return chain[at - 1]!
  }
  return chain.at(-1)!
}

/** The bounds of a box turned around its centre. */
export function turnedBounds(r: Rect & { rotation?: number }): Rect {
  const deg = r.rotation ?? 0
  if (!deg) return { x: r.x, y: r.y, w: r.w, h: r.h }
  const a = (deg * Math.PI) / 180
  const w = Math.abs(r.w * Math.cos(a)) + Math.abs(r.h * Math.sin(a))
  const h = Math.abs(r.w * Math.sin(a)) + Math.abs(r.h * Math.cos(a))
  return { x: r.x + r.w / 2 - w / 2, y: r.y + r.h / 2 - h / 2, w, h }
}

/**
 * Keeps groups true: members of a missing group leave it, groups with no members go, and every group's box (and
 * frame) becomes its members' — inner groups first, so nested boxes are right. Fixes the items in place and returns
 * the list without the dropped groups.
 */
export function fitGroups(items: CanvasItem[]): CanvasItem[] {
  const groupIds = new Set(items.filter((i) => i.kind === 'group').map((g) => g.id))
  for (const i of items) if (i.groupId && (!groupIds.has(i.groupId) || i.groupId === i.id || i.kind === 'frame')) delete i.groupId
  // Empty groups go; repeat, since removing one can empty its parent.
  let list = items
  for (;;) {
    const used = new Set(list.map((i) => i.groupId).filter(Boolean))
    const next = list.filter((i) => i.kind !== 'group' || used.has(i.id))
    if (next.length === list.length) break
    const kept = new Set(next.map((i) => i.id))
    for (const i of next) if (i.groupId && !kept.has(i.groupId)) delete i.groupId
    list = next
  }
  const byId = new Map(list.map((i) => [i.id, i]))
  const depth = (g: CanvasItem) => ancestorGroups(byId, g).length
  const ordered = list.filter((i): i is CanvasGroupItem => i.kind === 'group').sort((a, b) => depth(b) - depth(a))
  for (const g of ordered) {
    const members = list.filter((i) => i.groupId === g.id)
    const boxes = members.map((m) => turnedBounds(m))
    const x = Math.min(...boxes.map((b) => b.x))
    const y = Math.min(...boxes.map((b) => b.y))
    g.x = x
    g.y = y
    g.w = Math.max(1, Math.max(...boxes.map((b) => b.x + b.w)) - x)
    g.h = Math.max(1, Math.max(...boxes.map((b) => b.y + b.h)) - y)
    delete g.rotation
    const frameId = members[0]?.frameId
    if (frameId) g.frameId = frameId
    else delete g.frameId
  }
  return list
}
