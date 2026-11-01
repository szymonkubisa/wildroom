/**
 * One prompt compiler per model family (workflowFor(model).dialect): how the storyboard writes a multi-shot clip, a
 * single shot and its dialogue for LTX, Kling, Veo and Happy Horse. Models of no known family ('generic') are
 * written like LTX.
 */
import type { Dialect } from '@shared/models/workflow'
import { fitClip } from '../multishot'
import type { ClipInput, CompiledClip, DialectCompiler } from './common'
import { happyhorse } from './happyhorse'
import { kling } from './kling'
import { ltx } from './ltx'
import { veo } from './veo'

export * from './common'
export { fitClip }
export { klingShotList } from './kling'
export { PRESERVE_CHARACTERS } from './happyhorse'

const COMPILERS: Record<Dialect, DialectCompiler> = { ltx, generic: ltx, kling, veo, happyhorse }

export const compilerFor = (dialect: Dialect): DialectCompiler => COMPILERS[dialect]

/**
 * The richest clip the compiler writes that `fits` (the shrink ladder, fitClip). A shot list still over its
 * per-shot limit after the whole ladder has each shot cut down to it, so the model never rejects it.
 */
export function compileClip(compiler: DialectCompiler, input: ClipInput, fits: (clip: CompiledClip) => boolean): CompiledClip {
  const out = fitClip((knobs) => compiler.clip(input, knobs), fits)
  const limit = input.context.shotLimit
  return limit && compiler.clamp && out.shots?.some((s) => s.prompt.length > limit) ? compiler.clamp(out, limit) : out
}
