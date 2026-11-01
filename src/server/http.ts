import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { ProviderError } from './providers/types'

/** Error with an HTTP status, rendered as `{ error, details? }` by the app's error handler. */
export class ApiError extends Error {
  constructor(
    public readonly status: ContentfulStatusCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** Provider failures as HTTP errors the client can show ({ error, details: { code } }); anything else unchanged. */
export function apiErrorFrom(err: unknown): unknown {
  if (!(err instanceof ProviderError)) return err
  const { code, message, retryable } = err.jobError
  const status: ContentfulStatusCode =
    code === 'insufficient_credits'
      ? 402
      : code === 'rate_limited'
        ? 429
        : code === 'timeout'
          ? 504
          : code === 'provider' || code === 'network' || code === 'internal'
            ? 502
            : 400
  return new ApiError(status, message, { code, retryable })
}

export const badRequest = (message: string, details?: unknown) => new ApiError(400, message, details)
export const notFound = (what: string) => new ApiError(404, `${what} not found`)

export async function readJson<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T
  } catch {
    throw badRequest('Invalid JSON body')
  }
}

export function nowIso(): string {
  return new Date().toISOString()
}
