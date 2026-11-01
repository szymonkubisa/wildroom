import type { Player } from '@/engine/player'
import { playheadBus } from '@/engine/playhead'
import { useEditorStore } from '@/stores/editor'
import { useProjectStore } from '@/stores/project'

let player: Player | undefined
let lastStoreUpdate = 0

export function attachPlayer(p: Player) {
  player = p
}

export function detachPlayer(p: Player) {
  if (player === p) player = undefined
}

export function currentPlayer(): Player | undefined {
  return player
}

/** Called by the player on every displayed frame change. */
export function onPlayerFrame(frame: number) {
  playheadBus.set(frame)
  const now = performance.now()
  const editor = useEditorStore()
  if (!player?.playing || now - lastStoreUpdate > 100) {
    lastStoreUpdate = now
    editor.playhead = frame
  }
}

/** The frame under the playhead now: while playing the store's copy lags up to 100 ms, so ⌘B, M, I/O and ⌥F use the player's. */
export function currentFrame(): number {
  return player?.playing ? player.frame : useEditorStore().playhead
}

export function onPlayerState(playing: boolean) {
  const editor = useEditorStore()
  editor.playing = playing
  if (!playing && player) editor.playhead = player.frame
}

function duration() {
  const layout = useProjectStore().layout
  return Math.max(layout.duration, 0)
}

/** Playback / navigation used by the viewer, timeline and keyboard shortcuts. */
export const transport = {
  seek(frame: number) {
    const editor = useEditorStore()
    editor.previewAssetId = undefined
    const f = Math.max(0, Math.round(frame))
    editor.playhead = f
    playheadBus.set(f)
    player?.seek(f)
  },
  toggle() {
    useEditorStore().previewAssetId = undefined
    player?.toggle()
  },
  play(rate = 1) {
    useEditorStore().previewAssetId = undefined
    void player?.play(rate)
  },
  pause() {
    player?.pause()
  },
  shuttle(key: 'j' | 'k' | 'l') {
    useEditorStore().previewAssetId = undefined
    player?.shuttle(key)
  },
  step(delta: number) {
    const editor = useEditorStore()
    if (player?.playing) player.pause()
    transport.seek(Math.min(Math.max(0, editor.playhead + delta), Math.max(0, duration() - 1)))
  },
  goStart() {
    transport.seek(0)
  },
  goEnd() {
    transport.seek(Math.max(0, duration() - 1))
  },
  skim(frame: number | undefined) {
    player?.skim(frame)
  },
  /** Previous/next edit point (↑/↓). */
  jumpEdit(direction: -1 | 1) {
    const layout = useProjectStore().layout
    const points = new Set<number>([0])
    for (const s of layout.spine) {
      points.add(s.start)
      points.add(s.end)
    }
    for (const c of layout.connected) {
      points.add(c.start)
      points.add(c.end)
    }
    const sorted = [...points].sort((a, b) => a - b)
    const f = currentFrame()
    const target = direction > 0 ? sorted.find((p) => p > f) : [...sorted].reverse().find((p) => p < f)
    if (target !== undefined) transport.seek(Math.min(target, Math.max(0, duration() - 1)))
  },
  invalidate() {
    player?.invalidate()
  },
}
