import { Hono } from 'hono'
import { z } from 'zod'
import type {
  VoiceCloneRequest,
  VoiceCreatedResponse,
  VoiceDesignResponse,
  VoiceDesignSaveRequest,
} from '../../shared/types/voiceLab'
import { VOICE_LAB_LIMITS } from '../../shared/types/voiceLab'
import type { AppDeps } from '../app'
import type { AssetRow } from '../storage/records'
import { apiErrorFrom, badRequest, readJson } from '../http'
import { type VoiceSampleFile, cloneVoice, createDesignedVoice, designVoicePreviews } from '../providers/elevenlabs'
import { type Credentials, readCredentials } from '../services/keychain'

/**
 * Voice Lab: design a voice from a description (ElevenLabs Voice Design) or clone one from project audio
 * (Instant Voice Clone). Creating a voice changes the account's voice list — `onVoicesChanged` lets the caller drop
 * cached voice lists.
 */

const L = VOICE_LAB_LIMITS

const name = z
  .string({ error: 'Give the voice a name' })
  .trim()
  .min(1, 'Give the voice a name')
  .max(L.nameMax, `Voice names can be at most ${L.nameMax} characters`)

const description = z
  .string({ error: 'Describe the voice' })
  .trim()
  .min(L.descriptionMin, `Describe the voice in at least ${L.descriptionMin} characters`)
  .max(L.descriptionMax, `The description can be at most ${L.descriptionMax.toLocaleString('en-US')} characters`)

const designSchema = z.object({
  description,
  text: z
    .string()
    .trim()
    .max(L.sampleTextMax, `The sample text can be at most ${L.sampleTextMax.toLocaleString('en-US')} characters`)
    .refine((t) => t.length === 0 || t.length >= L.sampleTextMin, `The sample text needs at least ${L.sampleTextMin} characters — or leave it empty`)
    .optional(),
})

const saveSchema = z.object({
  name,
  description,
  generatedVoiceId: z.string({ error: 'Pick one of the previews first' }).trim().min(1, 'Pick one of the previews first'),
})

const cloneSchema = z.object({
  name,
  description: z
    .string()
    .trim()
    .max(L.descriptionMax, `The description can be at most ${L.descriptionMax.toLocaleString('en-US')} characters`)
    .optional(),
  assetIds: z
    .array(z.string().min(1), { error: 'Pick at least one voice sample' })
    .min(1, 'Pick at least one voice sample')
    .max(L.cloneFilesMax, `Use at most ${L.cloneFilesMax} voice samples`),
  consent: z.literal(true),
  removeBackgroundNoise: z.boolean().optional(),
})

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw badRequest(result.error.issues[0]?.message ?? 'Invalid request', result.error.issues)
  return result.data
}

const EXT_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  webm: 'audio/webm',
}

/** Upload name for a sample: the asset name (minus any extension) with the stored file's extension. */
export function sampleFileName(assetName: string, ext: string): string {
  const base =
    assetName
      .replace(/\.[a-z0-9]{2,5}$/i, '')
      .replace(/[^\w .()-]+/g, '_')
      .trim()
      .slice(0, 80) || 'sample'
  return `${base}.${ext}`
}

export function voiceLabRoutes(deps: AppDeps, opts: { onVoicesChanged?: () => void } = {}) {
  const r = new Hono()

  function credentials(): Credentials {
    const creds = readCredentials(deps.secrets, 'elevenlabs', ['apiKey'])
    if (!creds.apiKey) throw badRequest('Add your ElevenLabs key in Settings → Providers to use the Voice Lab')
    return creds
  }

  /** Audio assets upload their original file; video assets their extracted audio (the ingest WAV). */
  function sample(assetId: string): VoiceSampleFile {
    const row: AssetRow | undefined = deps.media.get(assetId)
    if (!row || row.deletedAt) throw badRequest(`Voice sample ${assetId} not found`)
    const label = `“${row.name}”`
    if (row.kind === 'audio') {
      const original = deps.media.variantPath(row, 'original')
      const mime = row.mime ?? (row.ext ? EXT_MIME[row.ext.toLowerCase()] : undefined)
      // Audio kept in a video container (e.g. foley results) goes up as the extracted WAV instead.
      if (original && mime?.startsWith('audio/')) return { path: original, filename: sampleFileName(row.name, row.ext ?? 'mp3'), mime }
      const wav = deps.media.variantPath(row, 'audio')
      if (wav) return { path: wav, filename: sampleFileName(row.name, 'wav'), mime: 'audio/wav' }
      if (original) return { path: original, filename: sampleFileName(row.name, row.ext ?? 'bin'), mime: mime ?? 'application/octet-stream' }
      throw badRequest(`${label} has no file on disk`)
    }
    if (row.kind === 'video') {
      if (!row.hasAudio) throw badRequest(`${label} has no audio track`)
      const wav = deps.media.variantPath(row, 'audio')
      if (!wav) throw badRequest(`${label} is still being processed — try again once its audio is ready`)
      return { path: wav, filename: sampleFileName(row.name, 'wav'), mime: 'audio/wav' }
    }
    throw badRequest(`${label} is an image — pick audio or video samples`)
  }

  r.post('/voices/design', async (c) => {
    const body = parse(designSchema, await readJson(c))
    const creds = credentials()
    try {
      // Aborts with the browser request: nothing is saved until /voices/design/save.
      const result = await designVoicePreviews(creds, { description: body.description, text: body.text || undefined }, c.req.raw.signal)
      const response: VoiceDesignResponse = {
        text: result.text,
        previews: result.previews.map((p) => ({
          generatedVoiceId: p.generatedVoiceId,
          audioUrl: `data:${p.mediaType};base64,${p.audioBase64}`,
          mediaType: p.mediaType,
          durationSeconds: p.durationSeconds,
          language: p.language,
        })),
      }
      return c.json(response)
    } catch (err) {
      throw apiErrorFrom(err)
    }
  })

  r.post('/voices/design/save', async (c) => {
    const body: VoiceDesignSaveRequest = parse(saveSchema, await readJson(c))
    const creds = credentials()
    try {
      // No abort signal: once sent, let the voice be created even if the browser goes away.
      const created = await createDesignedVoice(creds, body)
      opts.onVoicesChanged?.()
      return c.json({ voiceId: created.voiceId, name: created.name } satisfies VoiceCreatedResponse)
    } catch (err) {
      throw apiErrorFrom(err)
    }
  })

  r.post('/voices/clone', async (c) => {
    const raw = await readJson<Partial<VoiceCloneRequest> | null>(c)
    if (raw?.consent !== true) {
      throw badRequest('Confirm that you own this voice or have the speaker’s permission to clone it')
    }
    const body = parse(cloneSchema, raw)
    const creds = credentials()
    const files = [...new Set(body.assetIds)].map(sample)
    try {
      const created = await cloneVoice(creds, {
        name: body.name,
        description: body.description || undefined,
        files,
        removeBackgroundNoise: body.removeBackgroundNoise === true,
      })
      opts.onVoicesChanged?.()
      return c.json({
        voiceId: created.voiceId,
        name: created.name,
        requiresVerification: created.requiresVerification,
      } satisfies VoiceCreatedResponse)
    } catch (err) {
      throw apiErrorFrom(err)
    }
  })

  return r
}
