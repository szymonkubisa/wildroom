import Anthropic from '@anthropic-ai/sdk'
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'
import { createFalClient } from '@fal-ai/client'
import { z } from 'zod'
import {
  DEFAULT_TEXT_CHOICE,
  DEFAULT_TEXT_MODEL,
  type LlmVia,
  SUGGESTED_TEXT_MODELS,
  type TextModelChoice,
  type TextModelInfo,
  anthropicModelId,
} from '../../shared/types/llm'
import { ApiError, apiErrorFrom } from '../http'
import { falApiError } from '../providers/fal'
import { OPENROUTER_API, OPENROUTER_HEADERS } from '../providers/openrouter'
import { soundsLikeAuth, soundsLikeModeration } from '../providers/types'
import { cachedList } from './cachedList'

/** Keys that can run text models, plus the user's model choice (Settings → AI Director). */
export interface LlmCredentials {
  anthropic?: string
  openrouter?: string
  fal?: string
  choice?: TextModelChoice
}

export type LlmPart = { type: 'text'; text: string } | { type: 'image'; jpeg: Buffer }
/** A prompt: plain text, or text and JPEG frames (vision). */
export type LlmContent = string | LlmPart[]

export interface LlmTarget {
  via: LlmVia
  /** OpenRouter-style id (what the user picked). */
  model: string
  /** The id the provider is called with (Anthropic's own ids differ). */
  providerModel: string
}

export interface StructuredRequest<T> {
  system: string
  user: LlmContent
  schema: z.ZodType<T>
  /** The JSON shape in words, for models without schema-enforced output. */
  shape: string
  effort?: 'low' | 'medium' | 'high'
  /** The prompt has images: the model must read them. */
  vision?: boolean
}

// ------------------------------------------------------------------------------------------------ model catalogue

interface OpenRouterModel {
  id: string
  name?: string
  context_length?: number
  pricing?: { prompt?: string; completion?: string }
  architecture?: { input_modalities?: string[]; output_modalities?: string[] }
  supported_parameters?: string[]
}

const textModels = cachedList<TextModelInfo>(6 * 60 * 60_000)

const perMillion = (v: string | undefined) => {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6 * 1000) / 1000 : undefined
}

/** OpenRouter's catalogue entry → what the picker needs. Text-out models only; batch-only variants dropped. */
export function toTextModel(m: OpenRouterModel): TextModelInfo | undefined {
  const out = m.architecture?.output_modalities ?? ['text']
  if (!m.id || m.id.endsWith(':batch') || out.length !== 1 || out[0] !== 'text') return undefined
  return {
    id: m.id,
    name: (m.name ?? m.id).replace(/^[^:]{1,30}:\s*/, ''),
    contextLength: m.context_length,
    inputPrice: perMillion(m.pricing?.prompt),
    outputPrice: perMillion(m.pricing?.completion),
    vision: (m.architecture?.input_modalities ?? []).includes('image'),
    structured: (m.supported_parameters ?? []).includes('structured_outputs'),
    ...(SUGGESTED_TEXT_MODELS.includes(m.id) ? { suggested: true } : {}),
  }
}

/** OpenRouter's text models (public list, cached for 6 hours; the last good list survives a failed refresh). */
export function listTextModels(fetchImpl: typeof fetch = fetch): Promise<TextModelInfo[]> {
  return textModels.get(async () => {
    try {
      const res = await fetchImpl(`${OPENROUTER_API}/models`, { headers: OPENROUTER_HEADERS, signal: AbortSignal.timeout(15_000) })
      if (!res.ok) throw new Error(`OpenRouter models: HTTP ${res.status}`)
      const body = (await res.json()) as { data?: OpenRouterModel[] }
      const models = (body.data ?? []).flatMap((m) => toTextModel(m) ?? [])
      return models.sort((a, b) => Number(Boolean(b.suggested)) - Number(Boolean(a.suggested)) || a.name.localeCompare(b.name))
    } catch (err) {
      throw new ApiError(502, `Could not load the OpenRouter model list: ${err instanceof Error ? err.message : String(err)}`)
    }
  })
}

/** What we know about a model (undefined when the catalogue isn't loaded or the id is unknown). */
async function modelInfo(id: string, fetchImpl: typeof fetch = fetch): Promise<TextModelInfo | undefined> {
  try {
    return (await listTextModels(fetchImpl)).find((m) => m.id === id)
  } catch {
    return undefined
  }
}

/** For tests: forget the cached catalogue. */
export function resetModelCatalogue() {
  textModels.reset()
}

// ------------------------------------------------------------------------------------------------ routing

const NO_KEY = 'The AI Director needs an Anthropic, OpenRouter or fal.ai key (Settings → Providers)'

/**
 * Which provider runs the chosen model. `auto`: Claude models go to Anthropic directly when its key is set, anything
 * else to OpenRouter, then to fal.ai (which routes OpenRouter models, text only), and with only an Anthropic key to
 * Claude Opus 5.5. Vision jobs fall back to Claude Opus 5.5 when the chosen model can't read images, and leave the
 * fal.ai route for another key when one is set.
 */
export async function resolveTarget(creds: LlmCredentials, opts: { vision?: boolean } = {}): Promise<LlmTarget> {
  const choice = creds.choice ?? DEFAULT_TEXT_CHOICE
  let model = choice.model
  if (opts.vision) {
    // Text-only, or unknown to the (loaded) catalogue: Claude reads the frames. No catalogue: keep the choice.
    const catalogue = await listTextModels().catch(() => undefined)
    const info = catalogue?.find((m) => m.id === model)
    if (catalogue && !info?.vision) model = DEFAULT_TEXT_MODEL
  }
  const claude = anthropicModelId(model)
  const pick = (via: LlmVia): LlmTarget => ({ via, model, providerModel: via === 'anthropic' ? claude! : model })
  /** Claude Opus 5.5 on the Anthropic key: what runs when the chosen model needs a key that isn't set (the status line says so). */
  const opus = (): LlmTarget => ({ via: 'anthropic', model: DEFAULT_TEXT_MODEL, providerModel: anthropicModelId(DEFAULT_TEXT_MODEL)! })
  switch (choice.route) {
    case 'anthropic':
      if (!creds.anthropic) throw new ApiError(400, 'Add an Anthropic key (Settings → Providers), or let the Director pick the route automatically')
      if (!claude) throw new ApiError(400, `${model} isn't a Claude model — choose a Claude model or the OpenRouter route`)
      return pick('anthropic')
    case 'openrouter':
      if (!creds.openrouter) throw new ApiError(400, 'Add an OpenRouter key (Settings → Providers), or let the Director pick the route automatically')
      return pick('openrouter')
    case 'fal':
      if (!creds.fal) throw new ApiError(400, 'Add a fal.ai key (Settings → Providers), or let the Director pick the route automatically')
      if (opts.vision) {
        // fal.ai only passes text: frames go through another key when there is one.
        if (creds.openrouter) return pick('openrouter')
        if (creds.anthropic) return claude ? pick('anthropic') : opus()
        throw new ApiError(400, 'Looking at frames needs the Anthropic or OpenRouter route — fal.ai only passes text')
      }
      return pick('fal')
    default:
      if (claude && creds.anthropic) return pick('anthropic')
      if (creds.openrouter) return pick('openrouter')
      if (creds.fal && !opts.vision) return pick('fal')
      // Only an Anthropic key left: a model it can't run gives way to Claude.
      if (creds.anthropic) return opus()
      throw new ApiError(400, opts.vision ? 'Looking at frames needs an Anthropic or OpenRouter key (Settings → Providers)' : NO_KEY)
  }
}

// ------------------------------------------------------------------------------------------------ calls

export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const body = fenced ? fenced[1]! : text
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('No JSON object in the response')
  return JSON.parse(body.slice(start, end + 1))
}

function issuesOf(err: z.ZodError): string {
  return err.issues
    .slice(0, 4)
    .map((i) => `${i.path.join('.') || 'root'}: ${i.message}`)
    .join('; ')
}

/** Claude models where the server-side refusal fallback ("default" routing) is available. */
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'])

async function viaAnthropic<T>(key: string, model: string, req: StructuredRequest<T>): Promise<T> {
  const client = new Anthropic({ apiKey: key })
  const content: Anthropic.Beta.BetaContentBlockParam[] | string =
    typeof req.user === 'string'
      ? req.user
      : req.user.map((p) =>
          p.type === 'text'
            ? { type: 'text' as const, text: p.text }
            : { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data: p.jpeg.toString('base64') } },
        )
  const fallback = FALLBACK_MODELS.has(model)
  try {
    const response = await client.beta.messages.parse({
      model,
      max_tokens: 16000,
      ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      // Haiku takes no effort setting.
      output_config: { ...(model.includes('haiku') ? {} : { effort: req.effort ?? 'medium' }), format: betaZodOutputFormat(req.schema) },
      system: req.system,
      messages: [{ role: 'user', content }],
    })
    if (response.stop_reason === 'refusal') throw new ApiError(422, 'Claude declined this request — try rephrasing it')
    if (!response.parsed_output) throw new ApiError(502, 'Claude returned no structured result')
    return response.parsed_output as T
  } catch (err) {
    if (err instanceof ApiError) throw err
    if (err instanceof Anthropic.AuthenticationError) throw new ApiError(400, `Anthropic key is invalid (Settings → Providers): ${err.message}`)
    if (err instanceof Anthropic.NotFoundError) throw new ApiError(400, `Anthropic doesn't know the model ${model}: ${err.message}`)
    if (err instanceof Anthropic.RateLimitError) throw new ApiError(429, `Anthropic rate limit — try again shortly (${err.message})`)
    if (err instanceof Anthropic.APIError) throw new ApiError(502, `Anthropic API error ${err.status}: ${err.message}`)
    throw err
  }
}

interface ChatResponse {
  choices?: { message?: { content?: string | { type?: string; text?: string }[] | null }; finish_reason?: string }[]
  error?: { message?: string; code?: number | string }
}

function messageText(body: ChatResponse): string {
  const c = body.choices?.[0]?.message?.content
  if (typeof c === 'string') return c
  return (c ?? []).map((p) => (typeof p.text === 'string' ? p.text : '')).join('')
}

async function viaOpenRouter<T>(key: string, model: string, req: StructuredRequest<T>, fetchImpl: typeof fetch = fetch): Promise<T> {
  const parts = (extra: string) =>
    typeof req.user === 'string'
      ? `${req.user}${extra}`
      : [
          ...req.user.map((p) =>
            p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${p.jpeg.toString('base64')}` } },
          ),
          ...(extra ? [{ type: 'text', text: extra.trim() }] : []),
        ]
  const info = await modelInfo(model, fetchImpl)
  // Schema-enforced output where the model offers it; otherwise ask for the shape in words and validate.
  let structured = info?.structured !== false
  const jsonSchema = (() => {
    const { $schema: _drop, ...schema } = z.toJSONSchema(req.schema, { target: 'draft-7' }) as Record<string, unknown>
    return schema
  })()
  let feedback = ''
  for (let attempt = 0; attempt < 3; attempt++) {
    const extra = feedback ? `\n\nYour previous answer could not be used (${feedback}). Reply again with only the corrected JSON object.` : ''
    const res = await fetchImpl(`${OPENROUTER_API}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...OPENROUTER_HEADERS },
      signal: AbortSignal.timeout(240_000),
      body: JSON.stringify({
        model,
        max_tokens: 16000,
        messages: [
          { role: 'system', content: structured ? req.system : `${req.system}\n\nReply with a single JSON object and nothing else, shaped like:\n${req.shape}` },
          { role: 'user', content: parts(extra) },
        ],
        ...(structured
          ? { response_format: { type: 'json_schema', json_schema: { name: 'result', strict: true, schema: jsonSchema } }, provider: { require_parameters: true } }
          : {}),
      }),
    })
    const body = (await res.json().catch(() => ({}))) as ChatResponse
    if (!res.ok) {
      const message = body.error?.message ?? `HTTP ${res.status}`
      // 403 is also moderation and a key's spend limit: only 401 (or an auth-sounding 403) means the key is wrong.
      if (res.status === 401 || (res.status === 403 && soundsLikeAuth(message)))
        throw new ApiError(400, `OpenRouter key is invalid (Settings → Providers): ${message}`)
      if (res.status === 403) {
        if (soundsLikeModeration(message))
          throw new ApiError(422, `OpenRouter's moderation blocked this request for ${model} — pick another model in Settings → AI Director (${message})`)
        throw new ApiError(400, `OpenRouter refused the request: ${message}`)
      }
      if (res.status === 402) throw new ApiError(402, `OpenRouter needs more credits — top up at openrouter.ai/settings/credits (${message})`)
      if (res.status === 429) throw new ApiError(429, `OpenRouter rate limit — try again shortly (${message})`)
      // No endpoint serves this model with structured outputs: ask for the JSON in words instead.
      if (structured && (res.status === 400 || res.status === 404) && attempt === 0) {
        structured = false
        continue
      }
      if (res.status === 404) throw new ApiError(400, `OpenRouter doesn't serve ${model}: ${message}`)
      throw new ApiError(502, `OpenRouter error ${res.status}: ${message}`)
    }
    // A 200 can still carry a failure (the provider errored, or moderation cut the answer off).
    if (body.error?.message) throw new ApiError(502, `OpenRouter: ${body.error.message}`)
    const finish = body.choices?.[0]?.finish_reason
    if (finish === 'content_filter') throw new ApiError(422, `${model} stopped its answer for content reasons — try another model in Settings → AI Director`)
    if (finish === 'error') throw new ApiError(502, `${model} failed while answering — try again or pick another model`)
    const text = messageText(body)
    try {
      const parsed = req.schema.safeParse(extractJson(text))
      if (parsed.success) return parsed.data
      feedback = issuesOf(parsed.error)
    } catch (err) {
      feedback = err instanceof Error ? err.message : 'invalid JSON'
    }
  }
  throw new ApiError(502, `${model} did not return a valid result — try again or pick another model`)
}

async function viaFal<T>(key: string, model: string, req: StructuredRequest<T>): Promise<T> {
  if (typeof req.user !== 'string') throw new ApiError(400, 'fal.ai can only pass text to the model — use the Anthropic or OpenRouter route for frames')
  const fal = createFalClient({ credentials: key })
  let feedback = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = feedback
      ? `${req.user}\n\nYour previous answer could not be used (${feedback}). Reply again with only the corrected JSON object.`
      : req.user
    const result = await fal
      .subscribe('openrouter/router', {
        input: {
          model,
          system_prompt: `${req.system}\n\nReply with a single JSON object and nothing else, shaped like:\n${req.shape}`,
          prompt,
          temperature: 0.5,
          max_tokens: 16000,
          // fal rejects some models (Claude Opus 5.5) with 400 "Reasoning is mandatory for this endpoint" unless this is on.
          reasoning: true,
        },
      })
      .catch((err: unknown) => {
        // fal puts the reason in the body's `detail`; the client error's own message is just the status text.
        throw apiErrorFrom(falApiError(err) ?? err)
      })
    const text = String((result.data as { output?: unknown }).output ?? '')
    try {
      const parsed = req.schema.safeParse(extractJson(text))
      if (parsed.success) return parsed.data
      feedback = issuesOf(parsed.error)
    } catch (err) {
      feedback = err instanceof Error ? err.message : 'invalid JSON'
    }
  }
  throw new ApiError(502, 'The model did not return a valid result — try again')
}

/**
 * One structured answer from the chosen text model, through whichever key the route picks. Returns the result and
 * which route and model produced it (shown in the UI).
 */
export async function llmStructured<T>(creds: LlmCredentials, req: StructuredRequest<T>): Promise<{ result: T; via: LlmVia; model: string }> {
  const target = await resolveTarget(creds, { vision: req.vision })
  const run = () => {
    switch (target.via) {
      case 'anthropic':
        return viaAnthropic(creds.anthropic!, target.providerModel, req)
      case 'openrouter':
        return viaOpenRouter(creds.openrouter!, target.providerModel, req)
      default:
        return viaFal(creds.fal!, target.providerModel, req)
    }
  }
  return { result: await run(), via: target.via, model: target.model }
}

/** For tests: the OpenRouter call with an injected fetch. */
export const __test = { viaOpenRouter }
