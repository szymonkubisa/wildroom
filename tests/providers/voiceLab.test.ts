import { Hono } from 'hono'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { AppDeps } from '../../src/server/app'
import type { AssetRow } from '../../src/server/storage/records'
import { ApiError } from '../../src/server/http'
import { sampleFileName, voiceLabRoutes } from '../../src/server/routes/voiceLab'
import { MemorySecretStore } from '../../src/server/services/keychain'
import type { AssetVariant } from '../../src/shared/types/assets'
import { FAKE_MP3, installFetch, jsonResponse, makeFixtures } from './helpers'

const fixtures = makeFixtures()
const AUDIO_B64 = Buffer.from(FAKE_MP3).toString('base64')
const DESCRIPTION = 'A warm, slightly husky narrator in her forties with a calm British accent'

afterEach(() => {
  vi.unstubAllGlobals()
})
afterAll(() => fixtures.cleanup())

const row = (r: Partial<AssetRow> & Pick<AssetRow, 'id' | 'kind' | 'name'>) =>
  ({ status: 'ready', ext: null, mime: null, hasAudio: false, deletedAt: null, ...r }) as AssetRow

// Project media: an MP3, a video with extracted audio, and assets that can't be samples.
const takeMp3 = fixtures.file('take.mp3', 'mp3-take')
const interviewWav = fixtures.file('interview-audio.wav', 'RIFF-interview')
const foleyWav = fixtures.file('foley-audio.wav', 'RIFF-foley')
const ROWS = [
  row({ id: 'aud-1', kind: 'audio', name: 'Take 1.mp3', ext: 'mp3', mime: 'audio/mpeg', hasAudio: true }),
  row({ id: 'vid-1', kind: 'video', name: 'Interview / day 2', ext: 'mov', mime: 'video/quicktime', hasAudio: true }),
  row({ id: 'vid-silent', kind: 'video', name: 'B-roll', ext: 'mp4', mime: 'video/mp4', hasAudio: false }),
  row({ id: 'vid-new', kind: 'video', name: 'Fresh import', ext: 'mp4', mime: 'video/mp4', hasAudio: true, status: 'processing' }),
  row({ id: 'img-1', kind: 'image', name: 'Poster', ext: 'png', mime: 'image/png' }),
  row({ id: 'aud-gone', kind: 'audio', name: 'Deleted', ext: 'mp3', mime: 'audio/mpeg', hasAudio: true, deletedAt: '2026-09-01T00:00:00Z' }),
  row({ id: 'aud-mp4', kind: 'audio', name: 'Foley', ext: 'mp4', mime: 'video/mp4', hasAudio: true }),
]
const FILES: Record<string, Partial<Record<AssetVariant, string>>> = {
  'aud-1': { original: takeMp3 },
  'vid-1': { original: '/library/media/vid-1.mov', audio: interviewWav },
  'aud-mp4': { original: '/library/media/foley.mp4', audio: foleyWav },
}

function makeApp(opts: { apiKey?: string } = { apiKey: 'xi-test-key' }) {
  const secrets = new MemorySecretStore()
  if (opts.apiKey) secrets.set('elevenlabs', 'apiKey', opts.apiKey)
  const media = {
    get: (id: string) => ROWS.find((r) => r.id === id),
    variantPath: (r: AssetRow, variant: AssetVariant) => FILES[r.id]?.[variant],
  }
  const onVoicesChanged = vi.fn()
  const app = new Hono()
  // Same rendering as the real app's error handler.
  app.onError((err, c) => (err instanceof ApiError ? c.json({ error: err.message, details: err.details }, err.status) : c.json({ error: String(err) }, 500)))
  app.route('/api', voiceLabRoutes({ secrets, media } as unknown as AppDeps, { onVoicesChanged }))
  const post = async (path: string, body: unknown) => {
    const res = await app.request(`/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: res.status, json: (await res.json()) as Record<string, unknown> }
  }
  return { post, onVoicesChanged }
}

describe('POST /voices/design', () => {
  it('returns previews as playable data URLs', async () => {
    const { calls } = installFetch(() =>
      jsonResponse({
        previews: [
          { audio_base_64: AUDIO_B64, generated_voice_id: 'gen-1', media_type: 'audio/mpeg', duration_secs: 4.5, language: 'en' },
          { audio_base_64: AUDIO_B64, generated_voice_id: 'gen-2', media_type: 'audio/mpeg', duration_secs: 5 },
        ],
        text: 'Good evening, and welcome to the story.',
      }),
    )
    const { post, onVoicesChanged } = makeApp()
    const res = await post('/voices/design', { description: DESCRIPTION, text: '   ' })
    expect(res.status).toBe(200)
    expect(res.json).toEqual({
      text: 'Good evening, and welcome to the story.',
      previews: [
        { generatedVoiceId: 'gen-1', audioUrl: `data:audio/mpeg;base64,${AUDIO_B64}`, mediaType: 'audio/mpeg', durationSeconds: 4.5, language: 'en' },
        { generatedVoiceId: 'gen-2', audioUrl: `data:audio/mpeg;base64,${AUDIO_B64}`, mediaType: 'audio/mpeg', durationSeconds: 5 },
      ],
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.headers['xi-api-key']).toBe('xi-test-key')
    expect(calls[0]!.body).toEqual({ voice_description: DESCRIPTION, model_id: 'eleven_ttv_v3', auto_generate_text: true })
    // Previews don't touch the account's voice list.
    expect(onVoicesChanged).not.toHaveBeenCalled()
  })

  it('validates the description, the sample text and the key before calling ElevenLabs', async () => {
    const { calls } = installFetch(() => jsonResponse({}))
    const { post } = makeApp()
    expect(await post('/voices/design', { description: 'Deep voice' })).toMatchObject({
      status: 400,
      json: { error: 'Describe the voice in at least 20 characters' },
    })
    expect(await post('/voices/design', { description: DESCRIPTION, text: 'Hello there.' })).toMatchObject({
      status: 400,
      json: { error: 'The sample text needs at least 100 characters — or leave it empty' },
    })
    expect((await post('/voices/design', {})).status).toBe(400)
    expect(await makeApp({}).post('/voices/design', { description: DESCRIPTION })).toMatchObject({
      status: 400,
      json: { error: 'Add your ElevenLabs key in Settings → Providers to use the Voice Lab' },
    })
    expect(calls).toHaveLength(0)
  })

  it('passes provider errors through with a status and code', async () => {
    installFetch(() => jsonResponse({ detail: { status: 'quota_exceeded', message: 'This request exceeds your quota of 10000.' } }, 401))
    expect(await makeApp().post('/voices/design', { description: DESCRIPTION })).toMatchObject({
      status: 402,
      json: { error: expect.stringContaining('not enough credits'), details: { code: 'insufficient_credits' } },
    })
    installFetch(() => jsonResponse({ detail: 'A generation for this preview is already in progress. Retry the request.' }, 409))
    expect(await makeApp().post('/voices/design', { description: DESCRIPTION })).toMatchObject({
      status: 429,
      json: { details: { code: 'rate_limited', retryable: true } },
    })
  })
})

describe('POST /voices/design/save', () => {
  it('creates the voice and reports the voice list changed', async () => {
    const { calls } = installFetch(() => jsonResponse({ voice_id: 'voice-9', name: 'Narrator' }))
    const { post, onVoicesChanged } = makeApp()
    const res = await post('/voices/design/save', { name: '  Narrator ', description: DESCRIPTION, generatedVoiceId: 'gen-2' })
    expect(res).toEqual({ status: 200, json: { voiceId: 'voice-9', name: 'Narrator' } })
    expect(calls[0]!.url).toBe('https://api.elevenlabs.io/v1/text-to-voice')
    expect(calls[0]!.body).toEqual({ voice_name: 'Narrator', voice_description: DESCRIPTION, generated_voice_id: 'gen-2' })
    expect(onVoicesChanged).toHaveBeenCalledTimes(1)
  })

  it('rejects a missing name or preview', async () => {
    const { calls } = installFetch(() => jsonResponse({}))
    const { post, onVoicesChanged } = makeApp()
    expect(await post('/voices/design/save', { name: '', description: DESCRIPTION, generatedVoiceId: 'gen-2' })).toMatchObject({
      status: 400,
      json: { error: 'Give the voice a name' },
    })
    expect(await post('/voices/design/save', { name: 'Narrator', description: DESCRIPTION })).toMatchObject({
      status: 400,
      json: { error: 'Pick one of the previews first' },
    })
    expect(calls).toHaveLength(0)
    expect(onVoicesChanged).not.toHaveBeenCalled()
  })
})

describe('POST /voices/clone', () => {
  it('requires explicit consent', async () => {
    const { calls } = installFetch(() => jsonResponse({ voice_id: 'x' }))
    const { post } = makeApp()
    for (const consent of [undefined, false, 'true', 1]) {
      expect(await post('/voices/clone', { name: 'Me', assetIds: ['aud-1'], consent })).toMatchObject({
        status: 400,
        json: { error: 'Confirm that you own this voice or have the speaker’s permission to clone it' },
      })
    }
    expect(calls).toHaveLength(0)
  })

  it('uploads audio originals and the extracted audio of videos', async () => {
    const { calls } = installFetch(() => jsonResponse({ voice_id: 'clone-1', requires_verification: false }))
    const { post, onVoicesChanged } = makeApp()
    const res = await post('/voices/clone', {
      name: 'Interviewee',
      description: 'Soft-spoken, thoughtful',
      assetIds: ['aud-1', 'vid-1', 'aud-1', 'aud-mp4'],
      consent: true,
    })
    expect(res).toEqual({ status: 200, json: { voiceId: 'clone-1', name: 'Interviewee', requiresVerification: false } })
    expect(calls[0]!.url).toBe('https://api.elevenlabs.io/v1/voices/add')
    const form = calls[0]!.body as FormData
    expect(form.get('name')).toBe('Interviewee')
    expect(form.get('description')).toBe('Soft-spoken, thoughtful')
    expect(form.get('remove_background_noise')).toBe('false')
    const files = form.getAll('files') as File[]
    // Duplicates are sent once; audio kept in a video container goes up as its WAV.
    expect(files.map((f) => [f.name, f.type])).toEqual([
      ['Take 1.mp3', 'audio/mpeg'],
      ['Interview _ day 2.wav', 'audio/wav'],
      ['Foley.wav', 'audio/wav'],
    ])
    expect(await Promise.all(files.map((f) => f.text()))).toEqual(['mp3-take', 'RIFF-interview', 'RIFF-foley'])
    expect(onVoicesChanged).toHaveBeenCalledTimes(1)
  })

  it('passes background-noise removal and verification through', async () => {
    const { calls } = installFetch(() => jsonResponse({ voice_id: 'clone-2', requires_verification: true }))
    const res = await makeApp().post('/voices/clone', { name: 'Me', assetIds: ['aud-1'], consent: true, removeBackgroundNoise: true })
    expect(res.json).toEqual({ voiceId: 'clone-2', name: 'Me', requiresVerification: true })
    expect((calls[0]!.body as FormData).get('remove_background_noise')).toBe('true')
  })

  it('rejects samples that are not usable audio', async () => {
    const { calls } = installFetch(() => jsonResponse({ voice_id: 'x' }))
    const { post } = makeApp()
    const cases: [string[], string][] = [
      [['img-1'], '“Poster” is an image — pick audio or video samples'],
      [['vid-silent'], '“B-roll” has no audio track'],
      [['vid-new'], '“Fresh import” is still being processed — try again once its audio is ready'],
      [['missing'], 'Voice sample missing not found'],
      [['aud-gone'], 'Voice sample aud-gone not found'],
      [[], 'Pick at least one voice sample'],
      [Array.from({ length: 26 }, (_, i) => `a${i}`), 'Use at most 25 voice samples'],
    ]
    for (const [assetIds, error] of cases) {
      expect(await post('/voices/clone', { name: 'Me', assetIds, consent: true }), error).toMatchObject({ status: 400, json: { error } })
    }
    expect(await post('/voices/clone', { name: ' ', assetIds: ['aud-1'], consent: true })).toMatchObject({
      status: 400,
      json: { error: 'Give the voice a name' },
    })
    expect(calls).toHaveLength(0)
  })

  it('explains when the plan does not include cloning', async () => {
    installFetch(() =>
      jsonResponse({ detail: { status: 'can_not_use_instant_voice_cloning', message: 'Your subscription does not include instant voice cloning.' } }, 403),
    )
    const { post, onVoicesChanged } = makeApp()
    expect(await post('/voices/clone', { name: 'Me', assetIds: ['aud-1'], consent: true })).toMatchObject({
      status: 502,
      json: { error: expect.stringContaining('Instant Voice Cloning — it needs the Starter plan or above'), details: { code: 'provider' } },
    })
    expect(onVoicesChanged).not.toHaveBeenCalled()
  })
})

describe('sampleFileName', () => {
  it('keeps the asset name readable and uses the stored file extension', () => {
    expect(sampleFileName('Take 1.mp3', 'mp3')).toBe('Take 1.mp3')
    expect(sampleFileName('Interview / day 2', 'wav')).toBe('Interview _ day 2.wav')
    expect(sampleFileName('clip.mov', 'wav')).toBe('clip.wav')
    expect(sampleFileName('???', 'wav')).toBe('_.wav')
    expect(sampleFileName('', 'mp3')).toBe('sample.mp3')
  })
})
