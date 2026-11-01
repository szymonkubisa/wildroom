/**
 * Reads 48 kHz PCM WAV files (the ingest pipeline's audio variant) in windows via HTTP Range,
 * so long music beds never need to be decoded whole.
 */
export const CHUNK_SECONDS = 10

interface WavInfo {
  channels: number
  sampleRate: number
  bitsPerSample: number
  blockAlign: number
  dataOffset: number
  dataSize: number
  frames: number
}

const infoCache = new Map<string, Promise<WavInfo>>()
const chunkCache = new Map<string, Promise<AudioBuffer | undefined>>()
const chunkBytes = new Map<string, number>()
let cachedBytes = 0
const MAX_CACHE_BYTES = 400 * 1024 * 1024

function parseHeader(buf: ArrayBuffer, totalSize: number): WavInfo {
  const view = new DataView(buf)
  const tag = (o: number) => String.fromCharCode(view.getUint8(o), view.getUint8(o + 1), view.getUint8(o + 2), view.getUint8(o + 3))
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file')
  let offset = 12
  let fmt: Omit<WavInfo, 'dataOffset' | 'dataSize' | 'frames'> | undefined
  while (offset + 8 <= buf.byteLength) {
    const id = tag(offset)
    const size = view.getUint32(offset + 4, true)
    if (id === 'fmt ') {
      fmt = {
        channels: view.getUint16(offset + 10, true),
        sampleRate: view.getUint32(offset + 12, true),
        blockAlign: view.getUint16(offset + 20, true),
        bitsPerSample: view.getUint16(offset + 22, true),
      }
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV data before fmt chunk')
      const dataOffset = offset + 8
      // ffmpeg may write 0/0xFFFFFFFF sizes when streaming; fall back to the file size.
      const dataSize = size === 0 || size === 0xffffffff || dataOffset + size > totalSize ? totalSize - dataOffset : size
      return { ...fmt, dataOffset, dataSize, frames: Math.floor(dataSize / fmt.blockAlign) }
    }
    offset += 8 + size + (size % 2)
  }
  throw new Error('WAV data chunk not found in header window')
}

export function wavInfo(assetId: string): Promise<WavInfo> {
  let p = infoCache.get(assetId)
  if (!p) {
    p = fetch(`/media/${assetId}/audio`, { headers: { Range: 'bytes=0-65535' } }).then(async (res) => {
      if (!res.ok) throw new Error(`audio ${res.status}`)
      const total = Number(res.headers.get('content-range')?.split('/')[1] ?? res.headers.get('content-length') ?? 0)
      return parseHeader(await res.arrayBuffer(), total)
    })
    p.catch(() => infoCache.delete(assetId))
    infoCache.set(assetId, p)
  }
  return p
}

function evict() {
  for (const [key] of chunkCache) {
    if (cachedBytes <= MAX_CACHE_BYTES) break
    cachedBytes -= chunkBytes.get(key) ?? 0
    chunkBytes.delete(key)
    chunkCache.delete(key)
  }
}

/** AudioBuffer for chunk `index` (CHUNK_SECONDS each) of an asset's WAV, or undefined past the end. */
export function wavChunk(assetId: string, index: number): Promise<AudioBuffer | undefined> {
  const key = `${assetId}:${index}`
  const hit = chunkCache.get(key)
  if (hit) {
    // refresh LRU position
    chunkCache.delete(key)
    chunkCache.set(key, hit)
    return hit
  }
  const p = wavInfo(assetId).then(async (info) => {
    const framesPerChunk = CHUNK_SECONDS * info.sampleRate
    const firstFrame = index * framesPerChunk
    if (firstFrame >= info.frames) return undefined
    const frameCount = Math.min(framesPerChunk, info.frames - firstFrame)
    const start = info.dataOffset + firstFrame * info.blockAlign
    const end = start + frameCount * info.blockAlign - 1
    const res = await fetch(`/media/${assetId}/audio`, { headers: { Range: `bytes=${start}-${end}` } })
    if (!res.ok) throw new Error(`audio chunk ${res.status}`)
    const bytes = await res.arrayBuffer()
    const buffer = new AudioBuffer({ length: frameCount, numberOfChannels: 2, sampleRate: info.sampleRate })
    const left = buffer.getChannelData(0)
    const right = buffer.getChannelData(1)
    if (info.bitsPerSample === 16) {
      const pcm = new Int16Array(bytes, 0, frameCount * info.channels)
      for (let i = 0; i < frameCount; i++) {
        const l = pcm[i * info.channels]! / 32768
        left[i] = l
        right[i] = info.channels > 1 ? pcm[i * info.channels + 1]! / 32768 : l
      }
    } else if (info.bitsPerSample === 32) {
      const pcm = new Float32Array(bytes, 0, frameCount * info.channels)
      for (let i = 0; i < frameCount; i++) {
        left[i] = pcm[i * info.channels]!
        right[i] = info.channels > 1 ? pcm[i * info.channels + 1]! : left[i]!
      }
    } else {
      throw new Error(`Unsupported WAV bit depth ${info.bitsPerSample}`)
    }
    const size = frameCount * 2 * 4
    chunkBytes.set(key, size)
    cachedBytes += size
    evict()
    return buffer
  })
  p.catch(() => chunkCache.delete(key))
  chunkCache.set(key, p)
  return p
}
