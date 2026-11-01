import { workflowFor } from '../models/workflow'
import type { ModelSpec, ParamDef, ParamValues } from '../models/types'
import type { EnhanceReference } from '../types/api'

/** The most pictures the Director reads when it rewrites a prompt (more cost more and say little more). */
export const ENHANCE_MAX_REFERENCES = 6

/**
 * The pictures in the Composer's slots, as the Director should read them when it rewrites the prompt: each one's role
 * and how the prompt names it for this model — "@Image1" where the model numbers its references that way, else
 * "image 1"; the frames by what they are. Only the slots the model shows (`visible`), in their order.
 */
export function enhanceReferences(model: ModelSpec, values: ParamValues, visible: ParamDef[]): EnhanceReference[] {
  const castToken = model.output === 'video' ? workflowFor(model).cast?.token : undefined
  const numbered = (n: number) => (castToken?.includes('{n}') ? castToken.replace('{n}', String(n)) : `image ${n}`)
  const out: EnhanceReference[] = []
  for (const p of visible) {
    const v = values[p.key]
    if (p.ui.control === 'image' && typeof v === 'string' && v) {
      if (p.key === 'firstFrame') out.push({ assetId: v, role: 'start', token: 'the start frame' })
      else if (p.key === 'lastFrame') out.push({ assetId: v, role: 'end', token: 'the end frame' })
      else out.push({ assetId: v, role: 'input', token: 'the input image' })
    } else if (p.ui.control === 'images' && Array.isArray(v)) {
      v.filter((id): id is string => typeof id === 'string' && Boolean(id)).forEach((id, i) =>
        out.push(p.ui.source ? { assetId: id, role: 'input', token: 'the image to edit' } : { assetId: id, role: 'reference', token: numbered(i + 1) }),
      )
    }
  }
  return out.slice(0, ENHANCE_MAX_REFERENCES)
}
