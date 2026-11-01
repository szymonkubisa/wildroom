/**
 * Text models for the AI Director (script breakdown, briefs → asset sets, prompt help, frame analysis). Models are
 * named by their OpenRouter id ("anthropic/claude-opus-5.5"); the route says which key pays for the call.
 */

/** Who runs the call: Anthropic directly, OpenRouter, or OpenRouter models through fal.ai's router. */
export type LlmVia = 'anthropic' | 'openrouter' | 'fal'
/** `auto`: Anthropic for Claude models when its key is set, else OpenRouter, else fal.ai. */
export type LlmRoute = 'auto' | LlmVia
export const LLM_ROUTES: readonly LlmRoute[] = ['auto', 'anthropic', 'openrouter', 'fal']

export interface TextModelChoice {
  route: LlmRoute
  /** OpenRouter model id. */
  model: string
}

export const DEFAULT_TEXT_MODEL = 'anthropic/claude-opus-5.5'
export const DEFAULT_TEXT_CHOICE: TextModelChoice = { route: 'auto', model: DEFAULT_TEXT_MODEL }

/** A text model from OpenRouter's catalogue, as the model picker shows it. */
export interface TextModelInfo {
  id: string
  name: string
  contextLength?: number
  /** USD per million tokens. */
  inputPrice?: number
  outputPrice?: number
  /** Reads images (needed for describing media and checking continuity). */
  vision: boolean
  /** Supports JSON-schema structured outputs (more reliable results). */
  structured: boolean
  suggested?: boolean
}

/** Picked by default in the picker's "Suggested" group (checked against OpenRouter's catalogue, 2026-10). */
export const SUGGESTED_TEXT_MODELS = [
  'anthropic/claude-opus-5.5',
  'anthropic/claude-sonnet-5.5',
  'anthropic/claude-fable-5.1',
  'anthropic/claude-haiku-4.5',
  'openai/gpt-5.6-sol',
  'google/gemini-3.8-flash',
  'deepseek/deepseek-v4.1-flash',
  'mistralai/mistral-large-2512',
]

/** Anthropic API id of a Claude model named the OpenRouter way ("anthropic/claude-opus-5.5" → "claude-opus-5-5"). */
export function anthropicModelId(model: string): string | undefined {
  const m = /^anthropic\/(claude-[a-z0-9.-]+)$/i.exec(model.trim())
  return m ? m[1]!.toLowerCase().replace(/\./g, '-') : undefined
}

const MODEL_ID = /^[a-z0-9][a-z0-9._\-/:~]{1,150}$/i

/** A choice read from settings (or a request), repaired to something usable. */
export function sanitizeTextChoice(raw: unknown): TextModelChoice {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<TextModelChoice>
  const route = LLM_ROUTES.includes(r.route as LlmRoute) ? (r.route as LlmRoute) : 'auto'
  const model = typeof r.model === 'string' && MODEL_ID.test(r.model.trim()) ? r.model.trim() : DEFAULT_TEXT_MODEL
  return { route, model }
}

/** Short readable name: "anthropic/claude-opus-5.5" → "claude-opus-5.5". */
export function shortModelName(model: string): string {
  return model.includes('/') ? model.slice(model.indexOf('/') + 1) : model
}
