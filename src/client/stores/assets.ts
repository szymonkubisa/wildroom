import type { AssetDTO } from '@shared/types/assets'
import { defineStore } from 'pinia'
import { computed, ref, shallowRef, triggerRef, watch } from 'vue'
import { toast } from 'vue-sonner'
import { api, errorMessage } from '@/lib/api'
import { onServerEvent, onServerReconnect } from '@/lib/sse'

export interface UploadItem {
  id: string
  name: string
  progress: number
  /** The project the file goes into (an import keeps going after another project opens). */
  projectId: string
}

/** Assets of the open project, kept live via SSE. */
export const useAssetsStore = defineStore('assets', () => {
  const projectId = ref<string>()
  const byId = shallowRef(new Map<string, AssetDTO>())
  const loading = ref(false)
  const allUploads = ref<UploadItem[]>([])
  /** The open project's files on their way in. */
  const uploads = computed(() => allUploads.value.filter((u) => u.projectId === projectId.value))

  const list = computed(() =>
    [...byId.value.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0)),
  )
  /** Each generation's first output, also for generations the jobs store no longer holds (it keeps the newest only). */
  const byGeneration = computed(() => {
    const map = new Map<string, AssetDTO>()
    for (const asset of byId.value.values()) {
      const gid = asset.generation?.generationId
      if (!gid) continue
      const known = map.get(gid)
      if (!known || asset.createdAt < known.createdAt) map.set(gid, asset)
    }
    return map
  })

  function get(id: string | undefined): AssetDTO | undefined {
    return id ? byId.value.get(id) : undefined
  }

  /** Live server state: always wins. */
  function apply(asset: AssetDTO) {
    byId.value.set(asset.id, asset)
    triggerRef(byId)
  }

  /**
   * An API response can be older than a live update that already arrived — a small image is ingested before its
   * upload request returns, an asset finishes while the list loads — so a processing state never replaces a finished one.
   */
  function stale(incoming: AssetDTO, known: AssetDTO | undefined): boolean {
    return Boolean(known && known.status !== 'processing' && incoming.status === 'processing')
  }

  /** An asset from an API response (see `stale`). */
  function upsert(asset: AssetDTO) {
    // Answered after another project opened (an upload, a description): it belongs to the one it was asked in.
    if (projectId.value && !asset.projectIds.includes(projectId.value)) return
    if (stale(asset, byId.value.get(asset.id))) return
    apply(asset)
  }

  function drop(id: string) {
    if (byId.value.delete(id)) triggerRef(byId)
  }

  async function load(id: string) {
    projectId.value = id
    loading.value = true
    try {
      const listed = await api.assets.list(id)
      // Another project opened while this list loaded: its own list fills the store.
      if (projectId.value !== id) return
      const fresh = new Map(listed.map((a) => [a.id, a]))
      // Live updates for this project that arrived while the list loaded are newer than it.
      for (const live of byId.value.values()) {
        if (!live.projectIds.includes(id)) continue
        const listed = fresh.get(live.id)
        if (!listed || stale(listed, live)) fresh.set(live.id, live)
      }
      byId.value = fresh
    } finally {
      if (projectId.value === id) loading.value = false
    }
  }

  async function importFiles(files: File[]): Promise<AssetDTO[]> {
    const pid = projectId.value
    if (!pid) return []
    const imported: AssetDTO[] = []
    for (const file of files) {
      const item: UploadItem = { id: `${file.name}-${Date.now()}`, name: file.name, progress: 0, projectId: pid }
      allUploads.value.push(item)
      try {
        const asset = await api.assets.upload(pid, file, (p) => {
          const u = allUploads.value.find((x) => x.id === item.id)
          if (u) u.progress = p
        })
        upsert(asset)
        imported.push(asset)
      } catch (err) {
        toast.error(`Import failed: ${file.name}`, { description: errorMessage(err) })
      } finally {
        allUploads.value = allUploads.value.filter((x) => x.id !== item.id)
      }
    }
    return imported
  }

  /** Resolves when the asset has finished ingest (rejects on error or after `timeoutMs`). */
  function whenReady(id: string, timeoutMs = 120_000): Promise<AssetDTO> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const a = byId.value.get(id)
        if (a?.status === 'ready') return resolve(a), true
        if (a?.status === 'error' || a?.status === 'missing') return reject(new Error(a.error ?? 'Processing failed')), true
        return false
      }
      if (check()) return
      const stop = watch(byId, () => {
        if (check()) {
          stop()
          clearTimeout(timer)
        }
      })
      const timer = setTimeout(() => {
        stop()
        reject(new Error('Timed out waiting for the media to be processed'))
      }, timeoutMs)
    })
  }

  async function update(id: string, patch: Parameters<typeof api.assets.update>[1]) {
    upsert(await api.assets.update(id, patch))
  }

  async function remove(id: string) {
    if (!projectId.value) return
    await api.assets.remove(projectId.value, id)
    drop(id)
  }

  onServerEvent((event) => {
    if (event.type === 'asset.upserted') {
      if (projectId.value && event.asset.projectIds.includes(projectId.value)) apply(event.asset)
    } else if (event.type === 'asset.removed') {
      if (!event.projectId || event.projectId === projectId.value) drop(event.assetId)
    }
  })
  onServerReconnect(() => {
    if (projectId.value) void load(projectId.value)
  })

  return { projectId, byId, list, byGeneration, loading, uploads, get, upsert, load, importFiles, whenReady, update, remove }
})
