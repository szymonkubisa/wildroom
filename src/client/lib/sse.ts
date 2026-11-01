import type { ServerEvent } from '@shared/types/events'
import { shallowRef } from 'vue'

type Handler = (event: ServerEvent) => void

const handlers = new Set<Handler>()
let source: EventSource | undefined
let lastServerStart: string | undefined
const reconnectHandlers = new Set<() => void>()

/** One shared EventSource for the whole app; the browser reconnects automatically. */
export function onServerEvent(handler: Handler): () => void {
  handlers.add(handler)
  ensureConnected()
  return () => handlers.delete(handler)
}

/** Called when the server restarted (or the stream reconnected) — refetch state. */
export function onServerReconnect(handler: () => void): () => void {
  reconnectHandlers.add(handler)
  return () => reconnectHandlers.delete(handler)
}

/** EventSource.CLOSED: the browser gave up on the stream. */
const CLOSED = 2
const MAX_RETRY_MS = 10_000
let everOpened = false
/**
 * A connection attempt failed before this one opened: the server was down or restarting, so what the app loaded
 * meanwhile may have failed too — and state set before we connected (the GPU waiting for a choice) is never sent again.
 */
let missed = false
let retryMs = 1000

/**
 * The stream has been down for a while: the local server stopped (or is stuck), so every call fails until it is back.
 * A restart (the dev server reloading after an edit) takes a second or two and never shows.
 */
export const serverDown = shallowRef(false)
export const SERVER_DOWN_AFTER_MS = 4000
let downTimer: ReturnType<typeof setTimeout> | undefined

function ensureConnected() {
  if (!source) connect()
}

function connect() {
  const es = new EventSource('/api/events')
  source = es
  es.onopen = () => {
    retryMs = 1000
    clearTimeout(downTimer)
    downTimer = undefined
    serverDown.value = false
    if (everOpened || missed) for (const h of reconnectHandlers) h()
    everOpened = true
    missed = false
  }
  // The browser retries a dropped stream by itself, but gives up for good when a retry gets an HTTP error — the dev
  // proxy's 502 while the server restarts, for one. Then the UI would freeze on stale progress: open a new stream.
  es.onerror = () => {
    missed = true
    if (!downTimer && !serverDown.value) downTimer = setTimeout(() => (serverDown.value = true), SERVER_DOWN_AFTER_MS)
    if (es.readyState !== CLOSED) return
    es.close()
    setTimeout(() => {
      if (source === es) connect()
    }, retryMs)
    retryMs = Math.min(retryMs * 2, MAX_RETRY_MS)
  }
  es.onmessage = (msg) => {
    let event: ServerEvent
    try {
      event = JSON.parse(msg.data as string) as ServerEvent
    } catch {
      return
    }
    if (event.type === 'hello') {
      if (lastServerStart && lastServerStart !== event.serverStart) for (const h of reconnectHandlers) h()
      lastServerStart = event.serverStart
    }
    for (const handler of handlers) handler(event)
  }
}
