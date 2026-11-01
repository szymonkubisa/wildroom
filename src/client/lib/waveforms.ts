/** Waveform peaks (Uint8 0..255, `rate` per second) fetched once per asset and cached. */
const cache = new Map<string, Promise<Uint8Array | undefined>>()

export function loadWaveform(assetId: string): Promise<Uint8Array | undefined> {
  let entry = cache.get(assetId)
  if (!entry) {
    entry = fetch(`/media/${assetId}/waveform`)
      .then(async (res) => (res.ok ? new Uint8Array(await res.arrayBuffer()) : undefined))
      .catch(() => undefined)
    cache.set(assetId, entry)
    entry.then((v) => {
      if (!v) cache.delete(assetId) // retry later (variant may not be ready yet)
    })
  }
  return entry
}

/**
 * Draws a symmetric peak waveform for [startSec, endSec) of the asset into the canvas.
 * `gain` scales the peaks (clip volume) so the drawing reflects the mix.
 */
export function drawWaveform(
  canvas: HTMLCanvasElement,
  peaks: Uint8Array,
  rate: number,
  startSec: number,
  endSec: number,
  color: string,
  gain = 1,
) {
  const dpr = window.devicePixelRatio || 1
  const width = Math.max(1, Math.floor(canvas.clientWidth * dpr))
  const height = Math.max(1, Math.floor(canvas.clientHeight * dpr))
  if (canvas.width !== width) canvas.width = width
  if (canvas.height !== height) canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = color
  const span = Math.max(1e-6, endSec - startSec)
  const mid = height / 2
  for (let x = 0; x < width; x++) {
    const a = Math.floor((startSec + (x / width) * span) * rate)
    const b = Math.max(a + 1, Math.floor((startSec + ((x + 1) / width) * span) * rate))
    let peak = 0
    for (let i = a; i < b && i < peaks.length; i++) if (i >= 0 && peaks[i]! > peak) peak = peaks[i]!
    const h = Math.min(1, (peak / 255) * gain) * (height - 2)
    ctx.fillRect(x, mid - h / 2, 1, Math.max(1, h))
  }
}

export function roleColor(role: string | undefined): string {
  const base = role?.split('.')[0]
  const css = getComputedStyle(document.documentElement)
  const token =
    base === 'music' ? '--role-music' : base === 'effects' ? '--role-effects' : base === 'titles' ? '--role-titles' : base === 'video' ? '--role-video' : '--role-dialogue'
  return css.getPropertyValue(token).trim() || '#5aa'
}
