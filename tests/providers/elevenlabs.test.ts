import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { elevenLabsModels } from '../../src/shared/models/catalog/elevenlabs'
import type { ModelSpec } from '../../src/shared/models/types'
import {
  cloneVoice,
  createDesignedVoice,
  createElevenLabsAdapter,
  designVoicePreviews,
  elevenLabsError,
  listElevenLabsVoices,
  stripAudioTags,
  timestampsUnsupported,
  voiceLabError,
  wordsFromAlignment,
} from '../../src/server/providers/elevenlabs'
import { ProviderError, type SubmitResult } from '../../src/server/providers/types'
import { FAKE_MP3, bytesResponse, installFetch, jsonResponse, makeCtx, makeFixtures } from './helpers'

const model = (id: string): ModelSpec => elevenLabsModels.find((m) => m.id === id)!
const BASE = 'https://api.elevenlabs.io'
const CREDS = { apiKey: 'xi-test-key' }
const AUDIO_B64 = Buffer.from(FAKE_MP3).toString('base64')

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Character alignment for `text` where each character lasts 0.1 s. */
function alignmentFor(text: string) {
  const characters = [...text]
  return {
    characters,
    character_start_times_seconds: characters.map((_, i) => i * 0.1),
    character_end_times_seconds: characters.map((_, i) => i * 0.1 + 0.1),
  }
}

const doneOutput = (result: SubmitResult) => {
  if (result.type !== 'done') throw new Error('expected a done result')
  return result.outputs[0]!
}

describe('ElevenLabs text-to-speech', () => {
  it('uses /with-timestamps and returns audio + word timings', async () => {
    const { calls } = installFetch(() =>
      jsonResponse(
        { audio_base64: AUDIO_B64, alignment: alignmentFor('Hi there.'), normalized_alignment: alignmentFor('Hi there.') },
        200,
        { 'request-id': 'req-1', 'character-cost': '9' },
      ),
    )
    const { ctx, records } = makeCtx(model('eleven-v4-tts'), { voiceId: 'voice-1', text: 'Hi there.', seed: 42 }, { credentials: CREDS })
    const result = await createElevenLabsAdapter().submit(ctx)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`${BASE}/v1/text-to-speech/voice-1/with-timestamps?output_format=mp3_44100_192`)
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.headers).toMatchObject({ 'xi-api-key': 'xi-test-key', 'content-type': 'application/json' })
    expect(calls[0]!.body).toEqual({
      text: 'Hi there.',
      model_id: 'eleven_v4',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      seed: 42,
    })
    const output = doneOutput(result)
    expect(output.kind).toBe('buffer')
    expect(output.kind === 'buffer' && output.ext).toBe('mp3')
    expect(output.kind === 'buffer' && [...output.data]).toEqual([...FAKE_MP3])
    expect(output.meta).toEqual({
      alignment: {
        source: 'with-timestamps',
        words: [
          { text: 'Hi', start: 0, end: 0.2 },
          { text: 'there.', start: 0.3, end: 0.9 },
        ],
      },
      voiceId: 'voice-1',
      elevenLabsModel: 'eleven_v4',
    })
    expect(result.type === 'done' && result.response).toMatchObject({ requestId: 'req-1', characterCost: '9', words: 2 })
    expect(records).toEqual([{ endpoint: 'POST /v1/text-to-speech/voice-1/with-timestamps', outputFormat: 'mp3_44100_192', body: calls[0]!.body }])
  })

  it('falls back to plain TTS + forced alignment when /with-timestamps rejects the model', async () => {
    const handler = (call: { url: string }) => {
      if (call.url.includes('/with-timestamps'))
        return jsonResponse(
          { detail: { type: 'validation_error', code: 'unsupported_model', message: 'The specified model is not supported for this operation.' } },
          400,
        )
      if (call.url.includes('/v1/text-to-speech/')) return bytesResponse(FAKE_MP3)
      if (call.url.endsWith('/v1/forced-alignment'))
        return jsonResponse({
          characters: [],
          words: [
            { text: 'We', start: 0.05, end: 0.21, loss: 0.1 },
            { text: 'are', start: 0.25, end: 0.4, loss: 0.1 },
            { text: 'not', start: 0.45, end: 0.6, loss: 0.1 },
            { text: 'alone.', start: 0.62, end: 1.1234, loss: 0.2 },
          ],
          loss: 0.12,
        })
      return jsonResponse({}, 404)
    }
    const { calls } = installFetch(handler)
    const adapter = createElevenLabsAdapter()
    const { ctx, records } = makeCtx(model('eleven-v4-tts'), { voiceId: 'v 1', text: '[whispering] We are not alone.' }, { credentials: CREDS })
    const result = await adapter.submit(ctx)

    expect(calls.map((c) => c.url)).toEqual([
      `${BASE}/v1/text-to-speech/v%201/with-timestamps?output_format=mp3_44100_192`,
      `${BASE}/v1/text-to-speech/v%201?output_format=mp3_44100_192`,
      `${BASE}/v1/forced-alignment`,
    ])
    expect(calls[1]!.body).toEqual(calls[0]!.body)
    expect(calls[1]!.headers.accept).toBe('audio/mpeg')
    const form = calls[2]!.body as FormData
    expect(form).toBeInstanceOf(FormData)
    expect(form.get('text')).toBe('We are not alone.')
    const file = form.get('file') as File
    expect(file.name).toBe('speech.mp3')
    expect(file.type).toBe('audio/mpeg')
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(FAKE_MP3)
    expect(calls[2]!.headers['xi-api-key']).toBe('xi-test-key')

    expect(doneOutput(result).meta).toMatchObject({
      alignment: {
        source: 'forced-alignment',
        words: [
          { text: 'We', start: 0.05, end: 0.21 },
          { text: 'are', start: 0.25, end: 0.4 },
          { text: 'not', start: 0.45, end: 0.6 },
          { text: 'alone.', start: 0.62, end: 1.123 },
        ],
      },
    })
    expect(records.at(-1)).toMatchObject({ endpoint: 'POST /v1/text-to-speech/v%201' })

    // The adapter remembers: the next request for the same model skips /with-timestamps.
    calls.length = 0
    await adapter.submit(makeCtx(model('eleven-v4-tts'), { voiceId: 'voice-2', text: 'Again.' }, { credentials: CREDS }).ctx)
    expect(calls.map((c) => c.url)).toEqual([`${BASE}/v1/text-to-speech/voice-2?output_format=mp3_44100_192`, `${BASE}/v1/forced-alignment`])
  })

  it('keeps the paid audio when forced alignment fails', async () => {
    installFetch((call) => {
      if (call.url.includes('/with-timestamps')) return jsonResponse({ detail: { status: 'model_not_supported', message: 'Model does not support timestamps' } }, 422)
      if (call.url.includes('/v1/text-to-speech/')) return bytesResponse(FAKE_MP3)
      return jsonResponse({ detail: { message: 'Alignment service unavailable' } }, 503)
    })
    const result = await createElevenLabsAdapter().submit(makeCtx(model('eleven-v4-tts'), { voiceId: 'v', text: 'Hello.' }, { credentials: CREDS }).ctx)
    const output = doneOutput(result)
    expect(output.meta?.alignment).toBeUndefined()
    expect(String(output.meta?.alignmentError)).toContain('Alignment service unavailable')
  })

  it('does not fall back for text, voice or credit errors', async () => {
    const adapter = createElevenLabsAdapter()
    const cases: [Response, string][] = [
      [jsonResponse({ detail: { code: 'voice_not_found', message: 'The specified voice ID does not exist.' } }, 404), 'invalid_params'],
      [jsonResponse({ detail: { code: 'text_too_long', message: 'The provided text exceeds the maximum allowed length.' } }, 400), 'invalid_params'],
      [jsonResponse({ detail: { status: 'quota_exceeded', message: 'This request exceeds your quota of 10000.' } }, 401), 'insufficient_credits'],
    ]
    for (const [response, code] of cases) {
      const { calls } = installFetch(() => response)
      const error = await adapter
        .submit(makeCtx(model('eleven-multilingual-v2-tts'), { voiceId: 'v', text: 'Hi' }, { credentials: CREDS }).ctx)
        .catch((e: unknown) => e)
      expect(error).toBeInstanceOf(ProviderError)
      expect((error as ProviderError).jobError.code).toBe(code)
      expect(calls).toHaveLength(1)
    }
  })

  it('sends the voice settings each model supports', async () => {
    const { calls } = installFetch(() => jsonResponse({ audio_base64: AUDIO_B64, alignment: alignmentFor('Hi') }))
    const adapter = createElevenLabsAdapter()
    await adapter.submit(
      makeCtx(model('eleven-multilingual-v2-tts'), { voiceId: 'v', text: 'Hi', stability: 0.3, similarity: 0.9, style: 0.2, speed: 1.1 }, { credentials: CREDS }).ctx,
    )
    await adapter.submit(makeCtx(model('eleven-v3-tts'), { voiceId: 'v', text: 'Hi', stability: 0 }, { credentials: CREDS }).ctx)
    await adapter.submit(makeCtx(model('eleven-flash-v2.5-tts'), { voiceId: 'v', text: 'Hi', speed: 0.8 }, { credentials: CREDS }).ctx)
    await adapter.submit(makeCtx(model('eleven-v4-turbo-tts'), { voiceId: 'v', text: 'Hi' }, { credentials: CREDS }).ctx)
    expect(calls.map((c) => c.body)).toEqual([
      {
        text: 'Hi',
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.3, similarity_boost: 0.9, style: 0.2, speed: 1.1, use_speaker_boost: true },
      },
      { text: 'Hi', model_id: 'eleven_v3', voice_settings: { stability: 0 } },
      { text: 'Hi', model_id: 'eleven_flash_v2_5', voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: 0.8, use_speaker_boost: true } },
      { text: 'Hi', model_id: 'eleven_v4_turbo', voice_settings: { stability: 0.5, similarity_boost: 0.75 } },
    ])
  })

  it('drops to 128 kbps once when the plan does not allow 192 kbps', async () => {
    const { calls } = installFetch((call) =>
      call.url.includes('mp3_44100_192')
        ? jsonResponse({ detail: { status: 'output_format_not_allowed', message: 'mp3_44100_192 requires a Creator tier subscription or above' } }, 403)
        : jsonResponse({ audio_base64: AUDIO_B64, alignment: alignmentFor('Hi') }),
    )
    const adapter = createElevenLabsAdapter()
    const first = makeCtx(model('eleven-v4-tts'), { voiceId: 'v', text: 'Hi' }, { credentials: CREDS })
    await adapter.submit(first.ctx)
    await adapter.submit(makeCtx(model('eleven-v4-tts'), { voiceId: 'v', text: 'Hi' }, { credentials: CREDS }).ctx)
    expect(calls.map((c) => c.url.split('?')[1])).toEqual(['output_format=mp3_44100_192', 'output_format=mp3_44100_128', 'output_format=mp3_44100_128'])
    // The job record ends up describing the request that actually produced the audio.
    expect(first.records.map((r) => (r as { outputFormat: string }).outputFormat)).toEqual(['mp3_44100_192', 'mp3_44100_128'])
  })
})

describe('ElevenLabs dialogue, SFX and music', () => {
  it('sends dialogue with timestamps and keeps per-line voice segments', async () => {
    const text = 'Who are you?I am you.'
    const { calls } = installFetch(() =>
      jsonResponse({
        audio_base64: AUDIO_B64,
        alignment: alignmentFor(text),
        voice_segments: [
          { voice_id: 'alice', start_time_seconds: 0, end_time_seconds: 1.2, character_start_index: 0, character_end_index: 12, dialogue_input_index: 0 },
          { voice_id: 'bob', start_time_seconds: 1.2, end_time_seconds: 2.1, character_start_index: 12, character_end_index: 21, dialogue_input_index: 1 },
        ],
      }),
    )
    const lines = [
      { voiceId: 'alice', text: 'Who are you?' },
      { voiceId: 'bob', text: 'I am you.' },
    ]
    const result = await createElevenLabsAdapter().submit(makeCtx(model('eleven-dialogue'), { lines, seed: 7 }, { credentials: CREDS }).ctx)

    expect(calls[0]!.url).toBe(`${BASE}/v1/text-to-dialogue/with-timestamps?output_format=mp3_44100_192`)
    expect(calls[0]!.body).toEqual({
      inputs: [
        { text: 'Who are you?', voice_id: 'alice' },
        { text: 'I am you.', voice_id: 'bob' },
      ],
      model_id: 'eleven_v4',
      settings: { stability: 0.5 },
      seed: 7,
    })
    const meta = doneOutput(result).meta!
    expect(meta.voiceSegments).toEqual([
      { voiceId: 'alice', start: 0, end: 1.2, line: 0, charStart: 0, charEnd: 12 },
      { voiceId: 'bob', start: 1.2, end: 2.1, line: 1, charStart: 12, charEnd: 21 },
    ])
    const words = (meta.alignment as { words: { text: string; voiceId?: string; line?: number }[] }).words
    // "you?I" is split at the speaker boundary.
    expect(words.map((w) => [w.text, w.voiceId, w.line])).toEqual([
      ['Who', 'alice', 0],
      ['are', 'alice', 0],
      ['you?', 'alice', 0],
      ['I', 'bob', 1],
      ['am', 'bob', 1],
      ['you.', 'bob', 1],
    ])
  })

  it('generates sound effects with auto or fixed length', async () => {
    const { calls } = installFetch(() => bytesResponse(FAKE_MP3))
    const adapter = createElevenLabsAdapter()
    const auto = await adapter.submit(makeCtx(model('eleven-sfx'), { prompt: 'Door creak' }, { credentials: CREDS }).ctx)
    await adapter.submit(
      makeCtx(model('eleven-sfx'), { prompt: 'Rain loop', autoDuration: false, durationSeconds: 4.5, loop: true, promptInfluence: 0.8 }, { credentials: CREDS }).ctx,
    )
    expect(calls[0]!.url).toBe(`${BASE}/v1/sound-generation?output_format=mp3_44100_192`)
    expect(calls[0]!.headers.accept).toBe('audio/mpeg')
    expect(calls.map((c) => c.body)).toEqual([
      { text: 'Door creak', model_id: 'eleven_text_to_sound_v2', loop: false, prompt_influence: 0.3 },
      { text: 'Rain loop', model_id: 'eleven_text_to_sound_v2', duration_seconds: 4.5, loop: true, prompt_influence: 0.8 },
    ])
    expect(doneOutput(auto)).toMatchObject({ kind: 'buffer', ext: 'mp3' })
  })

  it('composes music and surfaces bad_prompt errors', async () => {
    const { calls } = installFetch(() => bytesResponse(FAKE_MP3))
    await createElevenLabsAdapter().submit(
      makeCtx(model('eleven-music'), { prompt: 'Tense strings', durationSeconds: 95 }, { credentials: CREDS }).ctx,
    )
    expect(calls[0]!.url).toBe(`${BASE}/v1/music?output_format=mp3_44100_192`)
    expect(calls[0]!.body).toEqual({ prompt: 'Tense strings', music_length_ms: 95_000, model_id: 'music_v2_5', force_instrumental: true })

    installFetch(() =>
      jsonResponse(
        {
          detail: {
            status: 'bad_prompt',
            message: 'The prompt references a copyrighted artist.',
            data: { prompt_suggestion: 'Moody synth-pop with breathy vocals' },
          },
        },
        400,
      ),
    )
    const error = await createElevenLabsAdapter()
      .submit(makeCtx(model('eleven-music'), { prompt: 'Song like a famous artist' }, { credentials: CREDS }).ctx)
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ProviderError)
    expect((error as ProviderError).jobError).toMatchObject({
      code: 'invalid_params',
      message: 'ElevenLabs rejected the prompt: The prompt references a copyrighted artist. — try: “Moody synth-pop with breathy vocals”',
    })
  })
})

describe('ElevenLabs test(), voices and errors', () => {
  it('reports plan and remaining credits', async () => {
    const { calls } = installFetch(() =>
      jsonResponse({ tier: 'creator', character_count: 12_000, character_limit: 100_000, next_character_count_reset_unix: 1_790_000_000, status: 'active' }),
    )
    const result = await createElevenLabsAdapter().test(CREDS)
    expect(calls[0]!.url).toBe(`${BASE}/v1/user/subscription`)
    expect(calls[0]!.headers['xi-api-key']).toBe('xi-test-key')
    expect(result).toEqual({
      ok: true,
      message: 'Connected — Creator plan',
      credits: { label: 'ElevenLabs credits', remaining: 88_000, limit: 100_000, unit: 'credits', resetsAt: new Date(1_790_000_000_000).toISOString() },
    })
  })

  it('reports an invalid key, and accepts restricted keys that can still list voices', async () => {
    installFetch(() => jsonResponse({ detail: { status: 'invalid_api_key', message: 'Invalid API key' } }, 401))
    expect(await createElevenLabsAdapter().test(CREDS)).toEqual({ ok: false, message: 'ElevenLabs: Invalid API key' })

    installFetch((call) =>
      call.url.includes('/v1/user/subscription')
        ? jsonResponse({ detail: { status: 'missing_permissions', message: 'The API key you used is missing the permission user_read' } }, 401)
        : jsonResponse({ voices: [], has_more: false }),
    )
    expect(await createElevenLabsAdapter().test(CREDS)).toMatchObject({ ok: true, message: expect.stringContaining('can’t read subscription') })
  })

  it('lists voices for the picker', async () => {
    const { calls } = installFetch(() =>
      jsonResponse({
        voices: [
          {
            voice_id: 'JBFqnCBsd6RMkjVDRZzb',
            name: 'George',
            category: 'premade',
            labels: { accent: 'british', gender: 'male', weird: 3 },
            description: 'Warm narrator',
            preview_url: 'https://storage.example/george.mp3',
          },
          { voice_id: 'x2', name: 'Custom', category: 'cloned', labels: null, description: null, preview_url: null },
        ],
        has_more: true,
        total_count: 30,
        next_page_token: 'page-2',
      }),
    )
    const page = await listElevenLabsVoices(CREDS, { search: 'geo', pageToken: 'page-1' })
    expect(calls[0]!.url).toBe(`${BASE}/v2/voices?page_size=100&search=geo&next_page_token=page-1`)
    expect(calls[0]!.headers['xi-api-key']).toBe('xi-test-key')
    expect(page).toEqual({
      voices: [
        {
          id: 'JBFqnCBsd6RMkjVDRZzb',
          name: 'George',
          category: 'premade',
          labels: { accent: 'british', gender: 'male' },
          previewUrl: 'https://storage.example/george.mp3',
          description: 'Warm narrator',
        },
        { id: 'x2', name: 'Custom', category: 'cloned', labels: {}, previewUrl: undefined, description: undefined },
      ],
      nextPageToken: 'page-2',
    })

    installFetch(() => jsonResponse({ voices: [], has_more: false, next_page_token: null }))
    expect(await listElevenLabsVoices(CREDS)).toEqual({ voices: [], nextPageToken: undefined })
    await expect(listElevenLabsVoices({})).rejects.toBeInstanceOf(ProviderError)
  })

  it('reads a page of voices bigger than an error page (a full account: 100 voices with samples and settings)', async () => {
    const voices = Array.from({ length: 100 }, (_, i) => ({
      voice_id: `v${i}`,
      name: `Voice ${i}`,
      category: 'professional',
      labels: { gender: 'female' },
      samples: null,
      fine_tuning: { is_allowed_to_fine_tune: true, state: { eleven_v4: 'fine_tuned' }, verification_failures: [] },
      description: 'x'.repeat(1500),
    }))
    installFetch(() => jsonResponse({ voices, has_more: false }))
    const page = await listElevenLabsVoices(CREDS)
    expect(page.voices).toHaveLength(100)
    expect(page.voices.at(-1)!.id).toBe('v99')
  })

  it('maps error responses', () => {
    const code = (status: number, body: unknown) => elevenLabsError(status, JSON.stringify(body)).jobError
    expect(code(401, { detail: { status: 'quota_exceeded', message: 'Quota exceeded' } })).toMatchObject({ code: 'insufficient_credits' })
    expect(code(402, { detail: { code: 'insufficient_credits', type: 'payment_required', message: 'Not enough credits' } })).toMatchObject({
      code: 'insufficient_credits',
    })
    expect(code(401, { detail: { code: 'invalid_api_key', message: 'The provided API key is invalid.' } })).toMatchObject({ code: 'auth' })
    expect(code(429, { detail: { code: 'concurrent_limit_exceeded', message: 'Too many concurrent requests' } })).toMatchObject({
      code: 'rate_limited',
      retryable: true,
    })
    expect(code(400, { detail: { status: 'content_policy_violation', message: 'Blocked' } })).toMatchObject({ code: 'moderation' })
    expect(code(403, { detail: { status: 'music_paid_plan_required', message: 'Music is only available on paid plans' } })).toMatchObject({
      code: 'provider',
      message: 'ElevenLabs: Music is only available on paid plans',
    })
    expect(code(500, { detail: { code: 'internal_error', message: 'Oops' } })).toMatchObject({ code: 'provider', retryable: true })
  })

  it('detects when /with-timestamps rejects the model', () => {
    const body = (b: unknown) => JSON.stringify(b)
    expect(timestampsUnsupported(400, body({ detail: { code: 'unsupported_model', message: 'x' } }))).toBe(true)
    expect(timestampsUnsupported(422, body({ detail: [{ loc: ['body', 'model_id'], msg: 'unexpected value', type: 'enum' }] }))).toBe(true)
    expect(timestampsUnsupported(404, body({ detail: 'Not Found' }))).toBe(true)
    expect(timestampsUnsupported(404, body({ detail: { code: 'voice_not_found', message: 'voice missing' } }))).toBe(false)
    expect(timestampsUnsupported(422, body({ detail: [{ loc: ['body', 'text'], msg: 'too long', type: 'value_error' }] }))).toBe(false)
    expect(timestampsUnsupported(401, body({ detail: { status: 'unsupported_model' } }))).toBe(false)
  })

  it('strips audio tags from alignment and forced-alignment text', () => {
    expect(stripAudioTags('[whispering] We are [sighs] not alone. [laughs softly]')).toBe('We are not alone.')
    expect(wordsFromAlignment(alignmentFor('[laughs] Ha, ha.')).map((w) => w.text)).toEqual(['Ha,', 'ha.'])
    expect(wordsFromAlignment(undefined)).toEqual([])
  })
})

describe('ElevenLabs Voice Lab', () => {
  const fixtures = makeFixtures()
  afterAll(() => fixtures.cleanup())

  const DESCRIPTION = 'A gravelly old sea captain with a warm Irish lilt, slow and amused'
  const SAMPLE =
    'Ahoy there, lad. Forty years I have sailed these grey waters, and not once did the sea give me back what she took from me.'
  /** Well over the 64 KB cap of the generic JSON reader — previews must not be truncated. */
  const BIG_AUDIO_B64 = Buffer.alloc(200_000, 7).toString('base64')

  /** Resolves to the rejection (fails the test if the promise resolves). */
  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => {
        throw new Error('expected a rejection')
      },
      (err: unknown) => err as ProviderError,
    )

  it('designs voice previews, letting ElevenLabs write the sample text', async () => {
    const { calls } = installFetch(() =>
      jsonResponse({
        previews: [
          { audio_base_64: AUDIO_B64, generated_voice_id: 'gen-1', media_type: 'audio/mpeg', duration_secs: 6.2, language: 'en' },
          { audio_base_64: AUDIO_B64, generated_voice_id: 'gen-2', media_type: 'audio/mpeg', duration_secs: 5.8, language: null },
          { generated_voice_id: 'gen-broken' },
        ],
        text: 'Ahoy there, lad.',
      }),
    )
    const result = await designVoicePreviews(CREDS, { description: `  ${DESCRIPTION}  ` })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`${BASE}/v1/text-to-voice/design?output_format=mp3_44100_128`)
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.headers).toMatchObject({ 'xi-api-key': 'xi-test-key', 'content-type': 'application/json', accept: 'application/json' })
    expect(calls[0]!.body).toEqual({ voice_description: DESCRIPTION, model_id: 'eleven_ttv_v3', auto_generate_text: true })
    expect(result).toEqual({
      previews: [
        { generatedVoiceId: 'gen-1', audioBase64: AUDIO_B64, mediaType: 'audio/mpeg', durationSeconds: 6.2, language: 'en' },
        { generatedVoiceId: 'gen-2', audioBase64: AUDIO_B64, mediaType: 'audio/mpeg', durationSeconds: 5.8 },
      ],
      text: 'Ahoy there, lad.',
    })
  })

  it('sends sample text and a model override, and reads large previews in full', async () => {
    const { calls } = installFetch(() =>
      jsonResponse({ previews: [{ audio_base_64: BIG_AUDIO_B64, generated_voice_id: 'gen-1', media_type: 'mp3', duration_secs: 9 }], text: SAMPLE }),
    )
    const result = await designVoicePreviews(CREDS, { description: DESCRIPTION, text: SAMPLE, model: 'eleven_multilingual_ttv_v2' })
    expect(calls[0]!.body).toEqual({ voice_description: DESCRIPTION, model_id: 'eleven_multilingual_ttv_v2', text: SAMPLE, auto_generate_text: false })
    expect(result.previews[0]!.audioBase64).toBe(BIG_AUDIO_B64)
    expect(result.previews[0]!.mediaType).toBe('audio/mpeg')
  })

  it('validates input before calling the API', async () => {
    const { calls } = installFetch(() => jsonResponse({}))
    expect((await failure(designVoicePreviews(CREDS, { description: 'Pirate voice' }))).jobError).toMatchObject({
      code: 'invalid_params',
      message: 'The voice description needs at least 20 characters (it has 12)',
    })
    expect((await failure(designVoicePreviews(CREDS, { description: DESCRIPTION, text: 'Too short to preview.' }))).jobError).toMatchObject({
      code: 'invalid_params',
      message: expect.stringContaining('at least 100 characters'),
    })
    expect((await failure(designVoicePreviews(CREDS, { description: 'x'.repeat(1001) }))).jobError.message).toContain('at most 1,000')
    expect((await failure(designVoicePreviews({}, { description: DESCRIPTION }))).jobError.code).toBe('auth')
    expect((await failure(createDesignedVoice(CREDS, { name: '  ', description: DESCRIPTION, generatedVoiceId: 'gen-1' }))).jobError.code).toBe(
      'invalid_params',
    )
    expect((await failure(createDesignedVoice(CREDS, { name: 'Captain', description: DESCRIPTION, generatedVoiceId: '' }))).jobError.message).toBe(
      'Pick one of the previews first',
    )
    expect((await failure(cloneVoice(CREDS, { name: 'Me', files: [] }))).jobError.message).toBe('Add at least one voice sample')
    const tooMany = Array.from({ length: 26 }, (_, i) => ({ path: `/nope/${i}.mp3`, filename: `${i}.mp3`, mime: 'audio/mpeg' }))
    expect((await failure(cloneVoice(CREDS, { name: 'Me', files: tooMany }))).jobError.message).toBe('Use at most 25 voice samples')
    expect(
      (await failure(cloneVoice(CREDS, { name: 'Me', files: [{ path: '/definitely/missing.mp3', filename: 'missing.mp3', mime: 'audio/mpeg' }] })))
        .jobError,
    ).toMatchObject({ code: 'invalid_params', message: 'Voice sample file is missing: missing.mp3' })
    expect(calls).toHaveLength(0)
  })

  it('saves a designed preview as a voice', async () => {
    const { calls } = installFetch(() =>
      jsonResponse({ voice_id: 'voice-new', name: 'Captain', category: 'generated', labels: {}, available_for_tiers: [], high_quality_base_model_ids: [] }),
    )
    const voice = await createDesignedVoice(CREDS, { name: ' Captain ', description: DESCRIPTION, generatedVoiceId: 'gen-2' })
    expect(calls[0]!.url).toBe(`${BASE}/v1/text-to-voice`)
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.headers).toMatchObject({ 'xi-api-key': 'xi-test-key', 'content-type': 'application/json' })
    expect(calls[0]!.body).toEqual({ voice_name: 'Captain', voice_description: DESCRIPTION, generated_voice_id: 'gen-2' })
    expect(voice).toEqual({ voiceId: 'voice-new', name: 'Captain' })
  })

  it('clones a voice from sample files as multipart form data', async () => {
    const take = fixtures.file('take-1.mp3', 'mp3-take-one')
    const interview = fixtures.file('interview.wav', 'RIFF-interview-wav')
    const { calls } = installFetch(() => jsonResponse({ voice_id: 'clone-1', requires_verification: false }))
    const voice = await cloneVoice(CREDS, {
      name: 'Narrator',
      description: ' Calm documentary narrator ',
      files: [
        { path: take, filename: 'Take 1.mp3', mime: 'audio/mpeg' },
        { path: interview, filename: 'Interview.wav', mime: 'audio/wav' },
      ],
      removeBackgroundNoise: true,
    })

    expect(calls[0]!.url).toBe(`${BASE}/v1/voices/add`)
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.headers['xi-api-key']).toBe('xi-test-key')
    // fetch sets multipart/form-data with the boundary itself.
    expect(calls[0]!.headers['content-type']).toBeUndefined()
    const form = calls[0]!.body as FormData
    expect(form).toBeInstanceOf(FormData)
    expect(form.get('name')).toBe('Narrator')
    expect(form.get('description')).toBe('Calm documentary narrator')
    expect(form.get('remove_background_noise')).toBe('true')
    const files = form.getAll('files') as File[]
    expect(files.map((f) => [f.name, f.type])).toEqual([
      ['Take 1.mp3', 'audio/mpeg'],
      ['Interview.wav', 'audio/wav'],
    ])
    expect(await files[0]!.text()).toBe('mp3-take-one')
    expect(await files[1]!.text()).toBe('RIFF-interview-wav')
    expect(voice).toEqual({ voiceId: 'clone-1', name: 'Narrator', requiresVerification: false })

    installFetch(() => jsonResponse({ voice_id: 'clone-2', requires_verification: true }))
    const second = await cloneVoice(CREDS, { name: 'Narrator 2', files: [{ path: take, filename: 'Take 1.mp3', mime: 'audio/mpeg' }] })
    expect(second.requiresVerification).toBe(true)
  })

  it('omits the optional description and defaults noise removal to off', async () => {
    const take = fixtures.file('take-2.mp3', 'mp3-take-two')
    const { calls } = installFetch(() => jsonResponse({ voice_id: 'clone-3', requires_verification: false }))
    await cloneVoice(CREDS, { name: 'Plain', files: [{ path: take, filename: 'Take 2.mp3', mime: 'audio/mpeg' }] })
    const form = calls[0]!.body as FormData
    expect(form.has('description')).toBe(false)
    expect(form.get('remove_background_noise')).toBe('false')
    expect(form.getAll('files')).toHaveLength(1)
  })

  it('explains plan limits, full voice slots, a busy design queue and expired previews', async () => {
    const mapped = (action: 'design' | 'save' | 'clone', status: number, body: unknown) => voiceLabError(action)(status, JSON.stringify(body)).jobError
    expect(
      mapped('clone', 403, {
        detail: { status: 'can_not_use_instant_voice_cloning', message: 'Your subscription does not include instant voice cloning.' },
      }),
    ).toEqual({
      code: 'provider',
      message:
        'ElevenLabs: your plan doesn’t include Instant Voice Cloning — it needs the Starter plan or above (Your subscription does not include instant voice cloning.)',
      retryable: false,
      maybeCharged: false,
    })
    const slots = {
      detail: {
        status: 'voice_limit_reached',
        message: 'You have reached your maximum amount of custom voices (3 / 3). You can upgrade your subscription to increase your custom voice limit.',
      },
    }
    expect(mapped('clone', 400, slots)).toMatchObject({ code: 'provider', message: expect.stringContaining('all your custom voice slots are in use') })
    expect(mapped('save', 400, slots).message).toContain('custom voice slots')
    expect(mapped('design', 409, { detail: 'A generation for this preview is already in progress. Retry the request.' })).toMatchObject({
      code: 'rate_limited',
      retryable: true,
    })
    expect(mapped('save', 404, { detail: { status: 'not_found', message: 'Generated voice not found.' } })).toMatchObject({
      code: 'invalid_params',
      message: expect.stringContaining('this preview is no longer available'),
    })
    expect(
      mapped('design', 422, { detail: [{ loc: ['body', 'text'], msg: 'String should have at least 100 characters', type: 'string_too_short' }] }),
    ).toMatchObject({ code: 'invalid_params', message: 'ElevenLabs: text: String should have at least 100 characters' })
    // Key problems stay auth errors; credits and rate limits map as for generations.
    expect(mapped('clone', 401, { detail: { status: 'invalid_api_key', message: 'Invalid API key' } }).code).toBe('auth')
    expect(
      mapped('clone', 401, {
        detail: { status: 'missing_permissions', message: 'The API key you used is missing the permission voices_write to execute this operation.' },
      }).code,
    ).toBe('auth')
    expect(mapped('design', 401, { detail: { status: 'quota_exceeded', message: 'This request exceeds your quota of 10000.' } }).code).toBe(
      'insufficient_credits',
    )
    expect(mapped('design', 429, { detail: { status: 'too_many_concurrent_requests', message: 'Too many requests' } }).code).toBe('rate_limited')
    expect(mapped('design', 500, { detail: { message: 'Oops' } })).toMatchObject({ code: 'provider', retryable: true })
  })

  it('uses the Voice Lab mapping for failed requests', async () => {
    const take = fixtures.file('take-3.mp3', 'mp3-take-three')
    installFetch(() =>
      jsonResponse({ detail: { status: 'can_not_use_instant_voice_cloning', message: 'Your subscription does not include instant voice cloning.' } }, 403),
    )
    const error = await failure(cloneVoice(CREDS, { name: 'Me', files: [{ path: take, filename: 'Take 3.mp3', mime: 'audio/mpeg' }] }))
    expect(error).toBeInstanceOf(ProviderError)
    expect(error.jobError.message).toContain('Instant Voice Cloning')

    installFetch(() => jsonResponse({ previews: [], text: '' }))
    expect((await failure(designVoicePreviews(CREDS, { description: DESCRIPTION }))).jobError).toMatchObject({ code: 'provider', retryable: true })

    installFetch(() => jsonResponse({ name: 'No id' }))
    expect((await failure(createDesignedVoice(CREDS, { name: 'X', description: DESCRIPTION, generatedVoiceId: 'g' }))).jobError).toMatchObject({
      code: 'provider',
      maybeCharged: true,
    })
  })
})
