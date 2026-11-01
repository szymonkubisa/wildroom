export function formatUsd(usd: number | null | undefined): string {
  if (usd == null) return '—'
  if (usd === 0) return 'Free'
  if (usd < 0.01) return '<$0.01'
  return `$${usd.toFixed(usd < 10 ? 2 : 0)}`
}

export function formatBytes(bytes: number | undefined): string {
  if (!bytes) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let n = bytes
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`
}

export function relativeTime(iso: string): string {
  const diff = Date.now() - Date.parse(iso)
  const s = Math.round(diff / 1000)
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  return d === 1 ? 'yesterday' : `${d} days ago`
}

/** "45 s", "6 min 12 s", "2 h 05 min": elapsed or remaining render time. */
export function formatSpan(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')} s`
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`
}

/** "~40 s", "~6 min", "~1 h 20 min": about how long a render will take. */
export function formatEta(seconds: number): string {
  const s = Math.max(1, Math.round(seconds))
  if (s < 60) return `~${s} s`
  const m = Math.round(s / 60)
  if (m < 60) return `~${m} min`
  return `~${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`
}
