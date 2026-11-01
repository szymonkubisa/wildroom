import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { ServerEvent } from '../../shared/types/events'
import type { AppDeps } from '../app'

export function eventRoutes(deps: AppDeps) {
  const r = new Hono()
  r.get('/events', (c) =>
    streamSSE(c, async (stream) => {
      const queue: ServerEvent[] = []
      let wake: (() => void) | undefined
      let closed = false
      const unsubscribe = deps.events.subscribe((event) => {
        queue.push(event)
        wake?.()
      })
      stream.onAbort(() => {
        closed = true
        unsubscribe()
        wake?.()
      })
      queue.push({ type: 'hello', serverStart: deps.serverStart })
      let lastWrite = Date.now()
      while (!closed) {
        while (queue.length) {
          const event = queue.shift()!
          await stream.writeSSE({ data: JSON.stringify(event) })
          lastWrite = Date.now()
        }
        await new Promise<void>((resolve) => {
          wake = resolve
          setTimeout(resolve, 15_000)
        })
        wake = undefined
        if (!closed && !queue.length && Date.now() - lastWrite >= 14_000) {
          await stream.write(': keep-alive\n\n')
          lastWrite = Date.now()
        }
      }
    }),
  )
  return r
}
