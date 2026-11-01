import { getModel } from '@shared/models/registry'
import { mentionsIn } from '@shared/prompt/mentions'
import { useGenerateStore } from '@/stores/generate'

/**
 * Library › Cast / Places → "Use in prompt": an @mention of the character or place at the end of the Composer's
 * prompt. It shows as a chip, and when sent becomes the subject's picture in the model's reference slot and the
 * model's own name for it (see @shared/prompt/mentions) — or its name and look in words where the model takes no
 * picture. The form keeps everything else (model, inputs, where the result goes). On a sound or tool kind it starts
 * an image instead.
 */
export function addToPrompt(handle: string) {
  const generate = useGenerateStore()
  const model = generate.modelId ? getModel(generate.modelId) : undefined
  const mention = `@${handle} `
  if (!model || (model.kind !== 'image' && model.kind !== 'video') || model.kind !== generate.kind) {
    return generate.open('image', { params: { prompt: mention } })
  }
  const key = model.params.find((p) => p.ui.control === 'prompt')?.key ?? 'prompt'
  const current = String(generate.values[key] ?? '')
  // Asked twice, it is there once.
  if (!mentionsIn(current, [{ handle }]).length) generate.values = { ...generate.values, [key]: `${current.trimEnd()}${current.trim() ? ' ' : ''}${mention}` }
  generate.focus()
}
