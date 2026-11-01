import type { ComfyTarget, ComfyViewDTO, GpuSessionDTO, VolumeSetupDTO } from '@shared/types/runpod'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { toast } from 'vue-sonner'
import { api, errorMessage } from '@/lib/api'
import { onServerEvent, onServerReconnect } from '@/lib/sse'

/** The rented GPU (RunPod): its session (off → starting → ready → stops when idle) and the volume setup. */
export const useGpuStore = defineStore('gpu', () => {
  const session = ref<GpuSessionDTO>({ state: 'off', busy: false })
  const setup = ref<VolumeSetupDTO>({ state: 'idle', lines: [] })
  const hfToken = ref<{ set: boolean; hint?: string }>({ set: false })
  const loaded = ref(false)

  async function load() {
    try {
      const [s, st] = await Promise.all([api.gpu.session(), api.gpu.setup()])
      session.value = s
      const { hfToken: hf, ...rest } = st
      setup.value = rest
      hfToken.value = hf
      loaded.value = true
    } catch {
      // The server may be restarting: the reconnect handler loads again.
    }
  }

  onServerEvent((event) => {
    if (event.type === 'gpu.session') session.value = event.session
    if (event.type === 'gpu.setup') setup.value = event.setup
  })
  onServerReconnect(() => void load())

  const running = computed(() => ['creating', 'booting', 'ready', 'stopping'].includes(session.value.state))
  const starting = computed(() => session.value.state === 'creating' || session.value.state === 'booting')

  async function act(fn: () => Promise<GpuSessionDTO>, failure: string) {
    try {
      session.value = await fn()
    } catch (err) {
      toast.error(failure, { description: errorMessage(err) })
    }
  }

  const start = () => act(api.gpu.start, 'Could not start the GPU')
  const stop = () => act(api.gpu.stop, 'Could not stop the GPU')
  const keep = () => act(api.gpu.keep, 'Could not keep the GPU on')
  const choose = (gpuId: string) => act(() => api.gpu.choose(gpuId), 'Could not rent that GPU')
  const decline = () => act(api.gpu.decline, 'Could not cancel')
  const keepWaiting = () => act(api.gpu.keepWaiting, 'Could not keep waiting')
  const offerOthers = () => act(api.gpu.offerOthers, 'Could not stop waiting')

  async function startSetup(token?: string) {
    try {
      setup.value = await api.gpu.startSetup(token)
      if (token) hfToken.value = { set: true }
    } catch (err) {
      toast.error('Could not start preparing the volume', { description: errorMessage(err) })
    }
  }

  async function cancelSetup() {
    try {
      setup.value = await api.gpu.cancelSetup()
    } catch (err) {
      toast.error('Could not cancel the setup', { description: errorMessage(err) })
    }
  }

  // ---------------------------------------------------------------- ComfyUI on the GPU

  const comfy = ref<ComfyViewDTO>()
  const comfyOpen = ref(false)

  /** Opens the ComfyUI window; opened from a project, the outputs queued there go to that project. */
  async function openComfy(projectId?: string) {
    try {
      let view = await api.gpu.comfy()
      if (projectId && view.target.projectId !== projectId) view = await api.gpu.setComfyTarget({ ...view.target, projectId })
      comfy.value = view
      comfyOpen.value = true
    } catch (err) {
      toast.error('Could not open ComfyUI', { description: errorMessage(err) })
    }
  }

  async function setComfyTarget(target: ComfyTarget) {
    try {
      comfy.value = await api.gpu.setComfyTarget(target)
    } catch (err) {
      toast.error('Could not change where the ComfyUI outputs go', { description: errorMessage(err) })
    }
  }

  return {
    session,
    setup,
    hfToken,
    loaded,
    running,
    starting,
    load,
    start,
    stop,
    keep,
    choose,
    decline,
    keepWaiting,
    offerOthers,
    startSetup,
    cancelSetup,
    comfy,
    comfyOpen,
    openComfy,
    setComfyTarget,
  }
})

/** Money spent so far in a session, from its start time and hourly price (the server publishes only changes). */
export function sessionCost(s: GpuSessionDTO, now: number): number | undefined {
  if (!s.startedAt || s.costPerHrUsd == null) return undefined
  return ((now - Date.parse(s.startedAt)) / 3_600_000) * s.costPerHrUsd
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}
