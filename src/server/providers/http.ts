import { createWriteStream, openAsBlob } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { type ProviderError, httpError } from './types'

/** Shared fetch helpers for the HTTP-based provider adapters (ElevenLabs, Kling, fal side calls). */

export type ErrorMapper = (status: number, body: string) => ProviderError

export interface FetchOptions {
  /** Provider label used in error messages ("ElevenLabs", "Kling"…). */
  label: string
  /** Caller's signal (the job's `ctx.signal`). An abort is re-thrown untouched. */
  signal?: AbortSignal
  /** Give up after this long; the error says so (an unknown outcome for submits). */
  timeoutMs?: number
}

/**
 * `fetch` with a timeout and readable network errors. Never throws because of the HTTP status —
 * callers decide (see `ensureOk`). Aborts caused by `opts.signal` propagate as the original AbortError
 * so the job worker can recognise a user cancel.
 */
export async function httpFetch(url: string, init: RequestInit, opts: FetchOptions): Promise<Response> {
  const timeout = opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined
  const signals = [opts.signal, timeout].filter((s): s is AbortSignal => Boolean(s))
  const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0]
  try {
    return await fetch(url, { ...init, signal })
  } catch (err) {
    if (opts.signal?.aborted) throw err
    if (timeout?.aborted) {
      throw new Error(`${opts.label}: no response after ${Math.round((opts.timeoutMs ?? 0) / 1000)} s`)
    }
    throw new Error(`${opts.label}: network error — ${describeNetworkError(err)}`)
  }
}

/** Throws the mapped provider error for a non-2xx response; returns the response otherwise. */
export async function ensureOk(res: Response, label: string, mapError?: ErrorMapper): Promise<Response> {
  if (res.ok) return res
  const body = await readText(res)
  throw (mapError ?? ((status: number, text: string) => httpError(status, text, label)))(res.status, body)
}

export async function fetchJson<T = unknown>(
  url: string,
  init: RequestInit,
  opts: FetchOptions & { mapError?: ErrorMapper },
): Promise<T> {
  const res = await ensureOk(await httpFetch(url, init, opts), opts.label, opts.mapError)
  // The whole body: readText's cap is for error pages, and a good answer can be bigger (100 ElevenLabs voices ≈ 150 KB).
  const text = await res.text().catch(() => '')
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`${opts.label}: unexpected non-JSON response (${text.slice(0, 200) || 'empty body'})`)
  }
}

export async function fetchBuffer(url: string, init: RequestInit, opts: FetchOptions & { mapError?: ErrorMapper }): Promise<Buffer> {
  const res = await ensureOk(await httpFetch(url, init, opts), opts.label, opts.mapError)
  const data = Buffer.from(await res.arrayBuffer())
  if (!data.length) throw new Error(`${opts.label}: empty response body`)
  return data
}

/** Reads a (possibly failed) response body as text, capped so a huge error page can't blow up logs. */
/** Streams a downloaded body into a file; a failed answer throws with its status. */
export async function saveBody(res: Response, path: string): Promise<void> {
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`)
  await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream), createWriteStream(path))
}

export async function readText(res: Response, max = 64_000): Promise<string> {
  try {
    const text = await res.text()
    return text.length > max ? text.slice(0, max) : text
  } catch {
    return ''
  }
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function describeNetworkError(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const cause = (err as Error & { cause?: unknown }).cause
  if (cause && typeof cause === 'object') {
    const code = (cause as { code?: unknown }).code
    const message = (cause as { message?: unknown }).message
    if (typeof code === 'string' && typeof message === 'string') return `${code}: ${message}`
    if (typeof message === 'string') return message
  }
  return err.message
}

// ---------------------------------------------------------------------------------------------- files

export async function fileToBase64(path: string): Promise<string> {
  return (await readFile(path)).toString('base64')
}

/** A lazily-read Blob for a file on disk (uploads stream it instead of buffering the whole file). */
export async function fileToBlob(path: string, mime: string): Promise<Blob> {
  return (await openAsBlob(path, { type: mime })) as unknown as Blob
}

// ------------------------------------------------------------------------------------ request records

const BASE64_RE = /^[A-Za-z0-9+/=\r\n]+$/

/**
 * Copy of a request payload that is safe and small enough to persist for debugging/remix:
 * base64 blobs and data URIs become `<base64 N bytes>`, binary becomes `<binary N bytes>`.
 * (The job worker additionally redacts key/secret/token fields.)
 */
export function summarizePayload(value: unknown, depth = 0): unknown {
  if (depth > 12) return '<nested>'
  if (typeof value === 'string') return summarizeString(value)
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `<binary ${value.byteLength} bytes>`
  if (value instanceof ArrayBuffer) return `<binary ${value.byteLength} bytes>`
  if (typeof Blob !== 'undefined' && value instanceof Blob) return `<binary ${value.size} bytes>`
  if (Array.isArray(value)) return value.map((v) => summarizePayload(v, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = summarizePayload(v, depth + 1)
    return out
  }
  return value
}

function summarizeString(value: string): string {
  const dataUri = /^data:([^;,]+)?;base64,/.exec(value)
  if (dataUri) return base64Placeholder(value.slice(dataUri[0].length))
  if (value.length > 512 && BASE64_RE.test(value)) return base64Placeholder(value)
  return value
}

/** `<base64 N bytes>` stand-in for an inline base64 payload. */
export function base64Placeholder(b64: string): string {
  return `<base64 ${base64Bytes(b64)} bytes>`
}

function base64Bytes(b64: string): number {
  const clean = b64.replace(/[\r\n]/g, '')
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding)
}

// ------------------------------------------------------------------------------ defensive JSON access

export type JsonRecord = Record<string, unknown>

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function asString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

export function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

/** First non-empty string among the candidates. */
export function firstString(...values: unknown[]): string | undefined {
  for (const v of values) {
    const s = asString(v)
    if (s) return s
  }
  return undefined
}

/** Removes `undefined` values (and optionally empty strings) so request bodies stay minimal. */
export function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null && v !== '') out[k] = v
  return out as Partial<T>
}

/** Extension from a MIME type or URL path (lower-case, no dot), or undefined. */
export function extFrom(contentType: unknown, url?: unknown): string | undefined {
  const mime = typeof contentType === 'string' ? contentType.split(';')[0]!.trim().toLowerCase() : ''
  const byMime: Record<string, string> = {
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/webm': 'webm',
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/wave': 'wav',
    'audio/flac': 'flac',
    'audio/ogg': 'ogg',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
  }
  if (byMime[mime]) return byMime[mime]
  if (typeof url === 'string') {
    try {
      const match = /\.([a-z0-9]{2,5})$/i.exec(new URL(url).pathname)
      if (match) return match[1]!.toLowerCase()
    } catch {
      // not a URL
    }
  }
  return undefined
}
