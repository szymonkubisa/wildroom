import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createOpenRouterAdapter } from '../../src/server/providers/openrouter'
import { __test, listTextModels, resetModelCatalogue, resolveTarget, toTextModel } from '../../src/server/services/llm'
import { anthropicModelId, sanitizeTextChoice } from '../../src/shared/types/llm'

const CATALOGUE = {
  data: [
    {
      id: 'anthropic/claude-opus-5.5',
      name: 'Anthropic: Claude Opus 5.5',
      context_length: 1000000,
      pricing: { prompt: '0.000004', completion: '0.00002' },
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
      supported_parameters: ['structured_outputs', 'response_format'],
    },
    { id: 'anthropic/claude-opus-5.5:batch', architecture: { output_modalities: ['text'] } },
    {
      id: 'mistralai/mistral-large',
      name: 'Mistral Large',
      pricing: { prompt: '0.000002', completion: '0.000006' },
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      supported_parameters: ['response_format'],
    },
    { id: 'black-forest-labs/flux', architecture: { input_modalities: ['text'], output_modalities: ['image'] } },
  ],
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** A fake OpenRouter: the catalogue, plus scripted chat replies (recorded). */
function fakeOpenRouter(replies: (Response | (() => Response))[]) {
  const calls: { url: string; body?: Record<string, unknown>; headers: Record<string, string> }[] = []
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/models')) return json(CATALOGUE)
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: init?.headers as Record<string, string> })
    const next = replies.shift()
    if (!next) throw new Error('unexpected call')
    return typeof next === 'function' ? next() : next
  })
  return { fetch: impl as unknown as typeof fetch, calls }
}

const chat = (content: string) => json({ choices: [{ message: { content } }] })
const schema = z.object({ title: z.string(), items: z.array(z.object({ name: z.string() })) })
const req = (user: Parameters<typeof __test.viaOpenRouter>[2]['user'] = 'Plan it') => ({
  system: 'You plan things.',
  user,
  schema,
  shape: '{"title": string, "items": [{"name": string}]}',
})

beforeEach(() => resetModelCatalogue())
afterEach(() => vi.unstubAllGlobals())

describe('text model catalogue', () => {
  it('keeps text models with prices per million tokens and capabilities', async () => {
    const { fetch } = fakeOpenRouter([])
    const models = await listTextModels(fetch)
    expect(models.map((m) => m.id)).toEqual(['anthropic/claude-opus-5.5', 'mistralai/mistral-large'])
    expect(models[0]).toMatchObject({ name: 'Claude Opus 5.5', inputPrice: 4, outputPrice: 20, vision: true, structured: true, suggested: true })
    expect(models[1]).toMatchObject({ vision: false, structured: false })
    expect(toTextModel({ id: 'x/image-model', architecture: { output_modalities: ['image'] } })).toBeUndefined()
  })
})

describe('routing', () => {
  beforeEach(() => vi.stubGlobal('fetch', fakeOpenRouter([]).fetch))
  const claude = { route: 'auto' as const, model: 'anthropic/claude-opus-5.5' }
  const mistral = { route: 'auto' as const, model: 'mistralai/mistral-large' }

  it('auto: Claude goes to Anthropic when its key is set, everything else to OpenRouter, then fal', async () => {
    expect(await resolveTarget({ anthropic: 'a', openrouter: 'o', choice: claude })).toEqual({ via: 'anthropic', model: claude.model, providerModel: 'claude-opus-5-5' })
    expect(await resolveTarget({ anthropic: 'a', openrouter: 'o', choice: mistral })).toMatchObject({ via: 'openrouter', providerModel: 'mistralai/mistral-large' })
    expect(await resolveTarget({ fal: 'f', choice: mistral })).toMatchObject({ via: 'fal', model: 'mistralai/mistral-large' })
    await expect(resolveTarget({ choice: claude })).rejects.toThrow(/Anthropic, OpenRouter or fal\.ai key/)
    // Only an Anthropic key: a model it can't run gives way to Claude instead of a "no key" error.
    expect(await resolveTarget({ anthropic: 'a', choice: mistral })).toEqual({ via: 'anthropic', model: claude.model, providerModel: 'claude-opus-5-5' })
  })

  it('explicit routes need their key, and Anthropic only takes Claude models', async () => {
    await expect(resolveTarget({ openrouter: 'o', choice: { ...claude, route: 'anthropic' } })).rejects.toThrow(/Anthropic key/)
    await expect(resolveTarget({ anthropic: 'a', choice: { ...mistral, route: 'anthropic' } })).rejects.toThrow(/isn't a Claude model/)
    expect(await resolveTarget({ anthropic: 'a', openrouter: 'o', choice: { ...claude, route: 'openrouter' } })).toMatchObject({ via: 'openrouter' })
  })

  it('vision: a model that cannot read images falls back to Claude Opus 5.5; fal cannot see', async () => {
    expect(await resolveTarget({ openrouter: 'o', choice: mistral }, { vision: true })).toMatchObject({ via: 'openrouter', model: 'anthropic/claude-opus-5.5' })
    await expect(resolveTarget({ fal: 'f', choice: claude }, { vision: true })).rejects.toThrow(/Anthropic or OpenRouter key/)
    await expect(resolveTarget({ fal: 'f', choice: { ...claude, route: 'fal' } }, { vision: true })).rejects.toThrow(/fal\.ai only passes text/)
    // The fal.ai route for text still lets frames go through another key that is set.
    expect(await resolveTarget({ fal: 'f', anthropic: 'a', choice: { ...mistral, route: 'fal' } }, { vision: true })).toMatchObject({ via: 'anthropic', model: claude.model })
    expect(await resolveTarget({ fal: 'f', openrouter: 'o', choice: { ...claude, route: 'fal' } }, { vision: true })).toMatchObject({ via: 'openrouter', model: claude.model })
    expect(await resolveTarget({ fal: 'f', anthropic: 'a', choice: { ...mistral, route: 'fal' } })).toMatchObject({ via: 'fal', model: mistral.model })
  })
})

describe('OpenRouter calls', () => {
  it('asks for schema-enforced JSON from models that support it, with images as data URLs', async () => {
    const or = fakeOpenRouter([chat('{"title":"Set","items":[{"name":"Logo"}]}')])
    const out = await __test.viaOpenRouter(
      'sk-or-test',
      'anthropic/claude-opus-5.5',
      req([
        { type: 'text', text: 'Frame 0:' },
        { type: 'image', jpeg: Buffer.from('jpg') },
      ]),
      or.fetch,
    )
    expect(out).toEqual({ title: 'Set', items: [{ name: 'Logo' }] })
    const call = or.calls[0]!
    expect(call.url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(call.headers.Authorization).toBe('Bearer sk-or-test')
    expect(call.headers['X-Title']).toBe('Wildroom')
    expect(call.body).toMatchObject({
      model: 'anthropic/claude-opus-5.5',
      provider: { require_parameters: true },
      response_format: { type: 'json_schema', json_schema: { name: 'result', strict: true } },
    })
    const schemaSent = (call.body!.response_format as { json_schema: { schema: Record<string, unknown> } }).json_schema.schema
    expect(schemaSent).toMatchObject({ type: 'object', required: ['title', 'items'], additionalProperties: false })
    expect(schemaSent.$schema).toBeUndefined()
    const user = (call.body!.messages as { role: string; content: unknown }[])[1]!.content
    expect(user).toEqual([
      { type: 'text', text: 'Frame 0:' },
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${Buffer.from('jpg').toString('base64')}` } },
    ])
  })

  it('describes the shape in words for models without structured outputs, and retries a bad answer', async () => {
    const or = fakeOpenRouter([chat('Sure! Here it is: {"title": 3}'), chat('```json\n{"title":"Ok","items":[]}\n```')])
    expect(await __test.viaOpenRouter('k', 'mistralai/mistral-large', req(), or.fetch)).toEqual({ title: 'Ok', items: [] })
    expect(or.calls[0]!.body!.response_format).toBeUndefined()
    expect(String((or.calls[0]!.body!.messages as { content: string }[])[0]!.content)).toContain('shaped like')
    expect(String((or.calls[1]!.body!.messages as { content: string }[])[1]!.content)).toContain('could not be used')
  })

  it('falls back to free-form JSON when no endpoint serves structured outputs', async () => {
    const or = fakeOpenRouter([json({ error: { message: 'No endpoints found that support response_format' } }, 404), chat('{"title":"T","items":[]}')])
    expect(await __test.viaOpenRouter('k', 'unknown/model', req(), or.fetch)).toEqual({ title: 'T', items: [] })
    expect(or.calls[0]!.body!.response_format).toBeDefined()
    expect(or.calls[1]!.body!.response_format).toBeUndefined()
  })

  it('turns auth, credit and rate errors into clear messages', async () => {
    await expect(__test.viaOpenRouter('bad', 'anthropic/claude-opus-5.5', req(), fakeOpenRouter([json({}, 401)]).fetch)).rejects.toThrow(/key is invalid/)
    await expect(__test.viaOpenRouter('k', 'anthropic/claude-opus-5.5', req(), fakeOpenRouter([json({}, 402)]).fetch)).rejects.toThrow(/needs more credits/)
    await expect(__test.viaOpenRouter('k', 'anthropic/claude-opus-5.5', req(), fakeOpenRouter([json({}, 429)]).fetch)).rejects.toThrow(/rate limit/)
  })

  it("doesn't blame the key for a 403 that is moderation or a spend limit", async () => {
    const flagged = json({ error: { message: 'openai/gpt-5.6-sol requires moderation on OpenRouter. Your input was flagged for "violence".' } }, 403)
    const moderated = __test.viaOpenRouter('k', 'openai/gpt-5.6-sol', req(), fakeOpenRouter([flagged]).fetch)
    await expect(moderated).rejects.toThrow(/moderation blocked this request for openai\/gpt-5.6-sol/)
    await expect(moderated).rejects.not.toThrow(/key is invalid/)
    const limit = json({ error: { message: 'Key limit exceeded (total limit). Manage it using https://openrouter.ai/settings/keys' } }, 403)
    await expect(__test.viaOpenRouter('k', 'openai/gpt-5.6-sol', req(), fakeOpenRouter([limit]).fetch)).rejects.toThrow(
      /OpenRouter refused the request: Key limit exceeded/,
    )
  })

  it('reports a failure carried by a 200 instead of retrying it as bad JSON', async () => {
    const errored = fakeOpenRouter([json({ error: { message: 'Provider returned error', code: 502 } })])
    await expect(__test.viaOpenRouter('k', 'anthropic/claude-opus-5.5', req(), errored.fetch)).rejects.toThrow(/Provider returned error/)
    expect(errored.calls).toHaveLength(1)
    const filtered = fakeOpenRouter([json({ choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] })])
    await expect(__test.viaOpenRouter('k', 'anthropic/claude-opus-5.5', req(), filtered.fetch)).rejects.toThrow(/content reasons/)
  })
})

describe('model choice', () => {
  it('maps Claude ids and repairs stored choices', () => {
    expect(anthropicModelId('anthropic/claude-opus-5.5')).toBe('claude-opus-5-5')
    expect(anthropicModelId('anthropic/claude-haiku-4.5')).toBe('claude-haiku-4-5')
    expect(anthropicModelId('openai/gpt-5.6-sol')).toBeUndefined()
    expect(sanitizeTextChoice({ route: 'openrouter', model: ' google/gemini-3.8-flash ' })).toEqual({ route: 'openrouter', model: 'google/gemini-3.8-flash' })
    expect(sanitizeTextChoice({ route: 'nope', model: 'bad model id!' })).toEqual({ route: 'auto', model: 'anthropic/claude-opus-5.5' })
    expect(sanitizeTextChoice(undefined)).toEqual({ route: 'auto', model: 'anthropic/claude-opus-5.5' })
  })
})

describe('OpenRouter key test', () => {
  it('reports the key label, spend and limit', async () => {
    const ok = createOpenRouterAdapter(
      (async () => json({ data: { label: 'studio', usage: 1.234, limit: 20, limit_remaining: 18.77, is_free_tier: false } })) as unknown as typeof fetch,
    )
    const res = await ok.test!({ apiKey: 'sk-or-x' })
    expect(res).toMatchObject({ ok: true, credits: { label: 'Key limit', remaining: 18.77, limit: 20, unit: 'USD' } })
    expect(res.message).toContain('$1.23 spent')
    const bad = createOpenRouterAdapter((async () => json({}, 401)) as unknown as typeof fetch)
    expect(await bad.test!({ apiKey: 'nope' })).toEqual({ ok: false, message: 'Invalid API key' })
    const capped = createOpenRouterAdapter((async () => json({ error: { message: 'Key limit exceeded' } }, 403)) as unknown as typeof fetch)
    expect(await capped.test!({ apiKey: 'sk-or-x' })).toEqual({ ok: false, message: 'OpenRouter error 403: Key limit exceeded' })
  })
})
