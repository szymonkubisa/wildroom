import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { parseParams } from '../../src/shared/models/params'
import type { ModelSpec, ParamValues } from '../../src/shared/models/types'
import type { JobContext, ResolvedInput } from '../../src/server/providers/types'
import type { Credentials } from '../../src/server/services/keychain'

export interface FetchCall {
  url: string
  method: string
  headers: Record<string, string>
  /** JSON-parsed body when possible, otherwise the raw body (FormData, string…). */
  body: unknown
}

/** Replaces global fetch with a handler; records every call. Undo with `vi.unstubAllGlobals()`. */
export function installFetch(handler: (call: FetchCall, index: number) => Response | Promise<Response>) {
  const calls: FetchCall[] = []
  const fn = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const headers: Record<string, string> = {}
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value
    })
    let body: unknown = init.body
    if (typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body)
      } catch {
        body = init.body
      }
    }
    const call: FetchCall = { url, method: (init.method ?? 'GET').toUpperCase(), headers, body }
    calls.push(call)
    return handler(call, calls.length - 1)
  })
  vi.stubGlobal('fetch', fn)
  return { calls, fn }
}

export const jsonResponse = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } })

export const bytesResponse = (data: Uint8Array, status = 200, headers: Record<string, string> = {}) =>
  new Response(new Uint8Array(data), { status, headers: { 'content-type': 'audio/mpeg', ...headers } })

/** Fake MP3 bytes. */
export const FAKE_MP3 = new Uint8Array(Buffer.from('ID3\u0004fake-mp3-audio-frames'))

/**
 * A JobContext whose params went through parseParams (defaults applied, hidden params stripped),
 * exactly like the job worker does. Recorded request payloads land in `records`.
 */
export function makeCtx(
  model: ModelSpec,
  input: ParamValues,
  opts: {
    inputs?: JobContext['inputs']
    credentials?: Credentials
    generationId?: string
    providerTaskId?: string
    providerMeta?: Record<string, unknown>
    signal?: AbortSignal
  } = {},
): { ctx: JobContext; records: unknown[] } {
  const parsed = parseParams(model, input)
  if (!parsed.ok) throw new Error(`Invalid params for ${model.id}: ${parsed.message}`)
  const records: unknown[] = []
  const ctx: JobContext = {
    generationId: opts.generationId ?? 'gen-1',
    model,
    params: parsed.values,
    inputs: opts.inputs ?? {},
    credentials: opts.credentials ?? { apiKey: 'test-api-key' },
    providerTaskId: opts.providerTaskId,
    providerMeta: opts.providerMeta ?? {},
    variant: 0,
    tmpDir: tmpdir(),
    signal: opts.signal ?? new AbortController().signal,
    recordRequest: (payload) => records.push(payload),
  }
  return { ctx, records }
}

/** Temp directory with small input files; call `cleanup()` in afterAll. */
export function makeFixtures() {
  const dir = mkdtempSync(join(tmpdir(), 'avs-providers-'))
  const file = (name: string, content: string | Uint8Array) => {
    const path = join(dir, name)
    writeFileSync(path, content)
    return path
  }
  const input = (assetId: string, path: string, kind: ResolvedInput['kind'], mime: string): ResolvedInput => ({ assetId, kind, path, mime })
  return {
    dir,
    file,
    image: (assetId: string, content = `png-bytes-${assetId}`) => input(assetId, file(`${assetId}.png`, content), 'image', 'image/png'),
    video: (assetId: string, content = `mp4-bytes-${assetId}`) => input(assetId, file(`${assetId}.mp4`, content), 'video', 'video/mp4'),
    audio: (assetId: string, content = `mp3-bytes-${assetId}`) => input(assetId, file(`${assetId}.mp3`, content), 'audio', 'audio/mpeg'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

/** Minimal extra input a model needs besides its defaults (prompt/text, voice, required assets…). */
export function minimalInput(model: ModelSpec): ParamValues {
  const values: ParamValues = {}
  for (const p of model.params) {
    if (p.default !== undefined) continue
    if (p.schema.safeParse(undefined).success) continue
    switch (p.ui.control) {
      case 'prompt':
        values[p.key] = 'A lighthouse keeper climbs the stairs at dusk'
        break
      case 'voice':
        values[p.key] = 'voice-1'
        break
      case 'image':
      case 'video':
      case 'audio':
        values[p.key] = `asset-${p.key}`
        break
      case 'images':
        values[p.key] = [`asset-${p.key}`]
        break
      default:
        if (p.key === 'lines') values[p.key] = [{ voiceId: 'voice-1', text: 'Hello there.' }]
        else if (p.key === 'endpointId') values[p.key] = 'fal-ai/some-model'
        else values[p.key] = 'x'
    }
  }
  return values
}
