type Listener = (frame: number) => void

/**
 * Live playhead position for per-frame DOM updates (timeline playhead line, timecode, meters).
 * Deliberately outside Vue reactivity; Pinia gets throttled updates.
 */
class PlayheadBus {
  frame = 0
  private listeners = new Set<Listener>()

  set(frame: number) {
    this.frame = frame
    for (const l of this.listeners) l(frame)
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    listener(this.frame)
    return () => this.listeners.delete(listener)
  }
}

export const playheadBus = new PlayheadBus()
