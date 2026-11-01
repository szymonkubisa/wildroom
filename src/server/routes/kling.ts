import { mkdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { nanoid } from 'nanoid'
import type { CreateKlingElementRequest, CreateKlingElementResponse, ListKlingElementsResponse } from '../../shared/types/kling'
import type { AppDeps } from '../app'
import { ApiError, badRequest, notFound, readJson } from '../http'
import {
  KLING_ELEMENT_MAX_REFERENCES,
  createKlingElement,
  deleteKlingElement,
  klingElementsAuthorization,
  listKlingElements,
} from '../providers/kling'
import { ProviderError, type ResolvedInput } from '../providers/types'
import { runFfmpeg } from '../services/ffmpeg'
import { type Credentials, readCredentials } from '../services/keychain'

/** Kling's element image rules (https://kling.ai/document-api/api/video/3-0-omni/elements). */
const ELEMENT_IMAGE_MIMES = new Set(['image/jpeg', 'image/jpg', 'image/png'])
const ELEMENT_IMAGE_MAX_BYTES = 10 * 1024 * 1024
const ELEMENT_IMAGE_MIN_SIDE = 300
const ELEMENT_IMAGE_MAX_RATIO = 2.5

const STATUS_BY_CODE: Record<string, ContentfulStatusCode> = {
  auth: 400,
  invalid_params: 400,
  moderation: 422,
  insufficient_credits: 402,
  rate_limited: 429,
}

/** Provider failures become API errors with a useful status and the provider's message. */
function asApiError(err: unknown): unknown {
  if (!(err instanceof ProviderError)) return err
  const status = STATUS_BY_CODE[err.jobError.code] ?? (err.jobError.retryable ? 503 : 502)
  return new ApiError(status, err.message, { code: err.jobError.code, retryable: err.jobError.retryable })
}

/**
 * Kling element library for story characters.
 *  - `POST /kling/elements` `{ name, description?, frontalAssetId, referenceAssetIds (1–3), replaceElementId? }`
 *    → `{ elementId, taskId?, sourceAssetIds, replaced? }` (waits for Kling, ~2 min max).
 *  - `GET /kling/elements[?scope=presets]` → `{ elements }` (the account's custom elements, or Kling's presets).
 */
export function klingRoutes(deps: AppDeps) {
  const r = new Hono()

  const credentials = (): Credentials => {
    const creds = readCredentials(deps.secrets, 'kling', ['apiKey', 'accessKey', 'secretKey'])
    try {
      klingElementsAuthorization(creds)
    } catch (err) {
      throw asApiError(err)
    }
    return creds
  }

  /** A ready image asset as a JPEG/PNG file Kling accepts (other formats and >10 MB files are converted). */
  async function elementImage(id: string, tmpFiles: string[]): Promise<ResolvedInput> {
    const row = deps.media.get(id)
    if (!row || row.deletedAt) throw notFound('Reference image')
    if (row.kind !== 'image') throw badRequest(`“${row.name}” is not an image`)
    if (row.status !== 'ready') throw badRequest(`“${row.name}” is still being imported — try again in a moment`)
    const original = deps.media.variantPath(row, 'original')
    if (!original) throw notFound(`The file of “${row.name}”`)
    const width = row.width ?? undefined
    const height = row.height ?? undefined
    if (width && height) {
      if (Math.min(width, height) < ELEMENT_IMAGE_MIN_SIDE)
        throw badRequest(`“${row.name}” is ${width}×${height} px — Kling needs at least ${ELEMENT_IMAGE_MIN_SIDE} px on each side`)
      const ratio = width / height
      if (ratio > ELEMENT_IMAGE_MAX_RATIO || ratio < 1 / ELEMENT_IMAGE_MAX_RATIO)
        throw badRequest(`“${row.name}” is too wide or too tall for Kling (aspect ratio between 1:2.5 and 2.5:1)`)
    }
    const mime = (row.mime ?? '').toLowerCase()
    const input: ResolvedInput = { assetId: row.id, kind: 'image', path: original, mime, width, height }
    if (ELEMENT_IMAGE_MIMES.has(mime) && (row.sizeBytes ?? 0) <= ELEMENT_IMAGE_MAX_BYTES) return input

    const dir = join(deps.env.tmpDir, 'kling-elements')
    mkdirSync(dir, { recursive: true })
    const out = join(dir, `${nanoid(8)}.jpg`)
    tmpFiles.push(out)
    try {
      await runFfmpeg([
        '-i',
        original,
        '-frames:v',
        '1',
        '-vf',
        "scale=w='min(2048,iw)':h='min(2048,ih)':force_original_aspect_ratio=decrease",
        '-q:v',
        '2',
        '-update',
        '1',
        out,
      ])
      return { ...input, path: out, mime: 'image/jpeg' }
    } catch {
      // ffmpeg cannot decode e.g. HEIC; the ingest poster (JPEG, 640 px wide) still makes a usable reference.
      const poster = deps.media.variantPath(row, 'poster')
      if (poster) return { ...input, path: poster, mime: 'image/jpeg' }
      throw badRequest(`“${row.name}” could not be converted for Kling — use a JPEG or PNG image`)
    }
  }

  r.post('/kling/elements', async (c) => {
    const body = await readJson<Partial<CreateKlingElementRequest>>(c)
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) throw badRequest('The character needs a name')
    if (typeof body.frontalAssetId !== 'string' || !body.frontalAssetId) throw badRequest('frontalAssetId is required')
    if (body.referenceAssetIds !== undefined && !Array.isArray(body.referenceAssetIds))
      throw badRequest('referenceAssetIds must be an array of asset ids')
    const referenceIds = [
      ...new Set((body.referenceAssetIds ?? []).filter((id): id is string => typeof id === 'string' && id.length > 0)),
    ]
      .filter((id) => id !== body.frontalAssetId)
      .slice(0, KLING_ELEMENT_MAX_REFERENCES)
    if (!referenceIds.length)
      throw badRequest(
        'Add at least one more reference image (another angle or a close-up) — Kling elements need a front image plus 1–3 extra views',
      )
    const creds = credentials()

    const tmpFiles: string[] = []
    try {
      const frontal = await elementImage(body.frontalAssetId, tmpFiles)
      const references: ResolvedInput[] = []
      for (const id of referenceIds) references.push(await elementImage(id, tmpFiles))
      const description = typeof body.description === 'string' ? body.description : ''
      let created: { elementId: string; taskId?: string }
      try {
        created = await createKlingElement(creds, { name, description, frontal, references }, c.req.raw.signal)
      } catch (err) {
        throw asApiError(err)
      }
      const response: CreateKlingElementResponse = {
        elementId: created.elementId,
        taskId: created.taskId,
        sourceAssetIds: [frontal.assetId, ...references.map((ref) => ref.assetId)],
      }
      const replace = typeof body.replaceElementId === 'string' ? body.replaceElementId : undefined
      if (replace && replace !== created.elementId) {
        try {
          await deleteKlingElement(creds, replace)
          response.replaced = true
        } catch (err) {
          console.warn(`[kling] could not delete replaced element ${replace}:`, err instanceof Error ? err.message : err)
        }
      }
      return c.json(response, 201)
    } finally {
      await Promise.all(tmpFiles.map((path) => rm(path, { force: true })))
    }
  })

  r.get('/kling/elements', async (c) => {
    const creds = credentials()
    try {
      const elements = await listKlingElements(creds, { presets: c.req.query('scope') === 'presets', signal: c.req.raw.signal })
      const response: ListKlingElementsResponse = { elements }
      return c.json(response)
    } catch (err) {
      throw asApiError(err)
    }
  })

  return r
}
