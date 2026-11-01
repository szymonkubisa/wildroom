function pad(n: number, width = 2): string {
  return String(Math.trunc(n)).padStart(width, '0')
}

/** HH:MM:SS:FF (non-drop-frame) for integer project frame rates. */
export function formatTimecode(frame: number, fps: number): string {
  const sign = frame < 0 ? '-' : ''
  const f = Math.abs(Math.round(frame))
  const fpsInt = Math.round(fps)
  const totalSeconds = Math.floor(f / fpsInt)
  const ff = f % fpsInt
  const ss = totalSeconds % 60
  const mm = Math.floor(totalSeconds / 60) % 60
  const hh = Math.floor(totalSeconds / 3600)
  return `${sign}${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`
}

/** Compact duration for badges: 0:05, 1:23, 1:02:03. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const s = Math.round(seconds)
  const hh = Math.floor(s / 3600)
  const mm = Math.floor(s / 60) % 60
  const ss = s % 60
  return hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`
}

/** Seconds with one decimal for short clips (e.g. "5.0s"). */
export function formatSecondsShort(seconds: number): string {
  return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`
}
