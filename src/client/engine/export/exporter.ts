import type { AssetDTO } from '@shared/types/assets'
import { canEncodeVideo } from 'mediabunny'
import { api } from '@/lib/api'
import { type MixerState, audioBufferToWav, renderMixdown } from '../audioEngine'
import type { FontSpec } from '../fonts'
import type { Scene } from '../scene'
import type { ExportAssetInfo, ExportCodec, ExportJob, ExportQuality, ExportWorkerMessage } from './types'

export interface ExportSettings {
  projectId: string
  name: string
  startFrame: number
  endFrame: number
  width: number
  height: number
  codec: ExportCodec
  quality: ExportQuality
  /** Integrated loudness target in LUFS, or null to leave levels untouched. */
  loudness: number | null
  /** Project font files (see `fontSpecs`). */
  fonts: FontSpec[]
}

export type ExportStage = 'video' | 'audio' | 'finalize'

/** The mix goes up as a WAV file, not JSON — which is all lib/api.ts's request() sends — so it has its own call. */
async function uploadMix(id: string, wav: Blob): Promise<void> {
  const res = await fetch(`/api/exports/${id}/audio`, { method: 'PUT', headers: { 'X-Studio': '1' }, body: wav })
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(data.error ?? `${res.status} ${res.statusText}`)
  }
}

export async function supportedCodecs(width: number, height: number): Promise<ExportCodec[]> {
  const out: ExportCodec[] = []
  for (const codec of ['avc', 'hevc'] as const) if (await canEncodeVideo(codec, { width, height })) out.push(codec)
  return out
}

/**
 * Browser-side render: a worker encodes picture (same compositor as the viewer), the main thread renders
 * the audio mix offline; the server muxes, loudness-normalises and adds the result to Assets.
 */
export async function runExport(
  scene: Scene,
  assets: Record<string, ExportAssetInfo>,
  mixer: MixerState,
  settings: ExportSettings,
  onProgress: (stage: ExportStage, fraction: number) => void,
  signal?: AbortSignal,
): Promise<AssetDTO> {
  const frames = settings.endFrame - settings.startFrame
  if (frames <= 0) throw new Error('Nothing to export')
  const { id } = await api.exports.create({ projectId: settings.projectId, name: settings.name, fps: scene.fps, frames })
  const worker = new Worker(new URL('./exportWorker.ts', import.meta.url), { type: 'module' })
  const abort = () => {
    worker.terminate()
    void api.exports.cancel(id).catch(() => {})
  }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    const videoDone = new Promise<void>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<ExportWorkerMessage>) => {
        const msg = e.data
        if (msg.type === 'progress') onProgress('video', msg.done / msg.total)
        else if (msg.type === 'done') resolve()
        else reject(new Error(msg.message))
      }
      worker.onerror = (e) => reject(new Error(e.message || 'Export worker crashed'))
    })
    const job: ExportJob = {
      exportId: id,
      scene: JSON.parse(JSON.stringify(scene)) as Scene,
      assets,
      startFrame: settings.startFrame,
      endFrame: settings.endFrame,
      width: settings.width,
      height: settings.height,
      codec: settings.codec,
      quality: settings.quality,
      fonts: settings.fonts,
    }
    worker.postMessage(job)

    onProgress('audio', 0)
    const mix = await renderMixdown(scene, settings.startFrame, settings.endFrame, mixer)
    await uploadMix(id, audioBufferToWav(mix))
    onProgress('audio', 1)

    await videoDone
    if (signal?.aborted) throw new DOMException('Export canceled', 'AbortError')
    onProgress('finalize', 0)
    const asset = await api.exports.finalize(id, settings.loudness)
    onProgress('finalize', 1)
    return asset
  } catch (err) {
    abort()
    throw err
  } finally {
    worker.terminate()
    signal?.removeEventListener('abort', abort)
  }
}
