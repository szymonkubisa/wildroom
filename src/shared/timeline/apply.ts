import { enablePatches, produceWithPatches } from 'immer'
import type { ProjectDoc } from '../types/project-doc'
import { layoutTimeline } from './layout'
import { normalize } from './normalize'
import type { OpContext, OpResult, RecipeContext, TimelineRecipe } from './types'

enablePatches()

/** Absolute frames of every connected item (start) and marker, keyed by id. */
export function absolutePositions(doc: ProjectDoc): Map<string, number> {
  const layout = layoutTimeline(doc)
  const abs = new Map<string, number>()
  for (const c of layout.connected) abs.set(c.id, c.start)
  for (const m of layout.markers) abs.set(m.id, m.frame)
  return abs
}

/**
 * Runs an op and `normalize` in one immer recipe. `patches` / `inversePatches` describe the whole change
 * (op + normalization), so undo is `applyPatches(result.doc, result.inversePatches)`.
 */
export function applyOp(doc: ProjectDoc, recipe: TimelineRecipe, ctx: OpContext): OpResult {
  const prevAbs = absolutePositions(doc)
  const [next, patches, inversePatches] = produceWithPatches(doc, (draft: ProjectDoc) => {
    const rctx: RecipeContext = { ...ctx, prevAbs }
    recipe(draft, rctx)
    normalize(draft, rctx.prevAbs, ctx.newId)
  })
  return { doc: next, patches, inversePatches }
}

/** Normalizes a document from elsewhere (disk, server, migration); returns the same object when already valid. */
export function normalizeDoc(doc: ProjectDoc, newId?: () => string): ProjectDoc {
  let n = 0
  const fallback = () => `gap-n${++n}`
  return applyOp(doc, () => {}, { newId: newId ?? fallback }).doc
}
