export interface FormatPreset {
  id: string
  label: string
  detail: string
  width: number
  height: number
}

export const FORMAT_PRESETS: FormatPreset[] = [
  { id: '1080p', label: 'Landscape', detail: '1920 × 1080 · 16:9', width: 1920, height: 1080 },
  { id: 'vertical', label: 'Vertical', detail: '1080 × 1920 · 9:16', width: 1080, height: 1920 },
  { id: 'square', label: 'Square', detail: '1080 × 1080 · 1:1', width: 1080, height: 1080 },
  { id: '4k', label: 'Cinema 4K', detail: '3840 × 2160 · 16:9', width: 3840, height: 2160 },
  { id: '720p', label: 'Draft 720p', detail: '1280 × 720 · 16:9', width: 1280, height: 720 },
]

export function aspectLabel(width: number, height: number): string {
  const r = width / height
  if (Math.abs(r - 16 / 9) < 0.01) return '16:9'
  if (Math.abs(r - 9 / 16) < 0.01) return '9:16'
  if (Math.abs(r - 1) < 0.01) return '1:1'
  if (Math.abs(r - 4 / 5) < 0.01) return '4:5'
  return `${width}×${height}`
}
