import type { Context } from 'hono'
import { Hono } from 'hono'
import { FLICKS_PER_SECOND } from '../../shared/time/flicks'
import type { SceneCutsRequest, SceneCutsResponse } from '../../shared/types/scenes'
import type { AppDeps } from '../app'
import { ApiError, badRequest, notFound } from '../http'
import { isAbortError } from '../services/ffmpeg'
import { detectSceneCuts, snapCuts } from '../services/scenes'

const round3 = (n: number) => Math.round(n * 1000) / 1000

/** The body is optional: an empty request means "use what the asset knows". */
async function optionalJson(c: Context): Promise<Partial<SceneCutsRequest>> {
  const text = await c.req.text()
  if (!text.trim()) return {}
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw badRequest('Invalid JSON body')
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Partial<SceneCutsRequest>) : {}
}

/** Expected cuts the Kling adapter stored with a multi-shot generation (`meta.multiShot.expectedCuts`). */
function storedExpectedCuts(meta: Record<string, unknown>): unknown[] | undefined {
  const cuts = (meta.multiShot as { expectedCuts?: unknown } | undefined)?.expectedCuts
  return Array.isArray(cuts) ? cuts : undefined
}

/** Finite times strictly inside the clip, rounded to ms, sorted, unique. */
function cleanTimes(values: readonly unknown[], duration: number | undefined): number[] {
  const times = values.map(Number).filter((t) => Number.isFinite(t) && t > 0 && (duration === undefined || t < duration))
  return [...new Set(times.map(round3))].sort((a, b) => a - b)
}

const optionalNumber = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

/**
 * `POST /assets/:id/scene-cuts` body `{ expected?, threshold?, tolerance? }` → `{ cuts, source, detected }`.
 * Times are seconds from the asset's t=0 (= proxy t=0, what timeline source times use). Detection runs on the
 * proxy when present, else on the original (shifted by the asset's time offset).
 */
export function sceneRoutes(deps: AppDeps) {
  const r = new Hono()

  r.post('/assets/:id/scene-cuts', async (c) => {
    let row = deps.media.get(c.req.param('id'))
    if (!row || row.deletedAt) throw notFound('Asset')
    if (row.kind !== 'video') throw badRequest('Shot detection needs a video asset')
    const body = await optionalJson(c)
    if (body.expected !== undefined && !Array.isArray(body.expected)) throw badRequest('expected must be an array of seconds')
    if (row.status === 'processing') {
      await deps.media.whenReady(row.id)
      row = deps.media.get(row.id) ?? row
    }

    const duration = row.durationFlicks ? row.durationFlicks / FLICKS_PER_SECOND : undefined
    const expected = cleanTimes(body.expected ?? storedExpectedCuts(row.meta) ?? [], duration)
    const proxy = deps.media.variantPath(row, 'proxy')
    const path = proxy ?? deps.media.variantPath(row, 'original')
    if (!path) throw notFound('Video file')

    let detected: number[] = []
    try {
      const found = await detectSceneCuts(path, {
        threshold: optionalNumber(body.threshold),
        origin: proxy ? 0 : (row.timeOffset ?? 0),
        signal: c.req.raw.signal,
      })
      detected = cleanTimes(found, duration)
    } catch (err) {
      if (isAbortError(err)) throw err
      const message = err instanceof Error ? err.message : String(err)
      if (!expected.length) throw new ApiError(500, `Shot detection failed: ${message}`)
      console.warn(`[scenes] detection failed for ${row.id}, using the expected cuts: ${message}`)
    }

    let response: SceneCutsResponse
    if (!expected.length) {
      response = { cuts: detected, source: 'detected', detected }
    } else {
      const { cuts, snapped } = snapCuts(expected, detected, optionalNumber(body.tolerance) ?? 0.5)
      response = { cuts: cleanTimes(cuts, duration), source: snapped > 0 ? 'refined' : 'expected', detected }
    }
    return c.json(response)
  })

  return r
}
