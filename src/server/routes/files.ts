import { createReadStream, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import type { Context } from 'hono'

/** Streams a file with HTTP Range support (needed for <video> seeking and WAV window reads). */
export function serveFile(c: Context, path: string, mime: string, extraHeaders: Record<string, string> = {}): Response {
  let size: number
  let mtime: number
  try {
    const stat = statSync(path)
    size = stat.size
    mtime = stat.mtimeMs
  } catch {
    return c.json({ error: 'File not found' }, 404)
  }
  const etag = `W/"${size.toString(16)}-${Math.floor(mtime).toString(16)}"`
  const headers: Record<string, string> = {
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    ETag: etag,
    'Cache-Control': 'no-cache',
    ...extraHeaders,
  }
  if (c.req.header('if-none-match') === etag) return new Response(null, { status: 304, headers })

  const range = c.req.header('range')
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    if (!match || (!match[1] && !match[2])) {
      return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } })
    }
    let start: number
    let end: number
    if (!match[1]) {
      const suffix = Number(match[2])
      start = Math.max(0, size - suffix)
      end = size - 1
    } else {
      start = Number(match[1])
      end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
    }
    if (start >= size || start > end) {
      return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } })
    }
    const body = c.req.method === 'HEAD' ? null : (Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream)
    return new Response(body, {
      status: 206,
      headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) },
    })
  }
  const body = c.req.method === 'HEAD' ? null : (Readable.toWeb(createReadStream(path)) as ReadableStream)
  return new Response(body, { status: 200, headers: { ...headers, 'Content-Length': String(size) } })
}
