import type { ServerEvent } from '../../shared/types/events'

type Listener = (event: ServerEvent) => void

/** In-process pub/sub feeding the SSE stream. */
export class EventBus {
  private listeners = new Set<Listener>()

  publish(event: ServerEvent) {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (err) {
        console.error('[events] listener failed', err)
      }
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
