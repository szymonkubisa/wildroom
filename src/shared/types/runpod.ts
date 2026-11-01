/**
 * Rented GPUs on RunPod for LTX-2.5 (ComfyUI on a pod, models on a network volume). Shared by the server (pod
 * creation, sessions) and the client (Settings, the GPU choice dialog, cost estimates).
 */

/** Which LTX-2.5 weights a GPU runs: full bf16 needs ~80 GB; smaller cards use the int8 set. */
export type GpuPrecision = 'bf16' | 'int8'

export interface LtxGpu {
  /** RunPod GPU type id (as `POST /v2/pods` takes it). */
  id: string
  name: string
  vramGb: number
  precision: GpuPrecision
  /** Secure Cloud on-demand price per hour, for estimates only (live prices come from RunPod). */
  priceUsdHr: number
  note?: string
}

export const GPU_PRICES_AS_OF = '2026-10-06'

/** GPUs that run LTX-2.5 well, best first. Prices: RunPod Secure Cloud, checked 2026-10-06. */
export const LTX_GPUS: readonly LtxGpu[] = [
  { id: 'NVIDIA RTX PRO 6000 Blackwell Server Edition', name: 'RTX PRO 6000', vramGb: 96, precision: 'bf16', priceUsdHr: 2.09, note: 'Best value: full quality, 4K and long clips.' },
  { id: 'NVIDIA RTX PRO 6000 Blackwell Workstation Edition', name: 'RTX PRO 6000 WK', vramGb: 96, precision: 'bf16', priceUsdHr: 2.19, note: 'Same card with more system RAM: loads models faster.' },
  { id: 'NVIDIA H100 NVL', name: 'H100 NVL', vramGb: 94, precision: 'bf16', priceUsdHr: 3.19, note: 'Full quality, fast.' },
  { id: 'NVIDIA H100 80GB HBM3', name: 'H100 SXM', vramGb: 80, precision: 'bf16', priceUsdHr: 3.49, note: 'Full quality, fastest of the 80 GB cards.' },
  { id: 'NVIDIA H100 PCIe', name: 'H100 PCIe', vramGb: 80, precision: 'bf16', priceUsdHr: 2.89, note: 'Full quality.' },
  { id: 'NVIDIA A100-SXM4-80GB', name: 'A100 SXM', vramGb: 80, precision: 'bf16', priceUsdHr: 1.59, note: 'Full quality, slower than Hopper/Blackwell.' },
  { id: 'NVIDIA A100 80GB PCIe', name: 'A100 PCIe', vramGb: 80, precision: 'bf16', priceUsdHr: 1.59, note: 'Full quality, slower than Hopper/Blackwell.' },
  { id: 'NVIDIA H200', name: 'H200', vramGb: 141, precision: 'bf16', priceUsdHr: 4.59, note: 'Most memory: long 4K clips. Expensive.' },
  { id: 'NVIDIA L40S', name: 'L40S', vramGb: 48, precision: 'int8', priceUsdHr: 1.09, note: 'int8 weights: slightly less detail; 4K is slow.' },
  { id: 'NVIDIA RTX 6000 Ada Generation', name: 'RTX 6000 Ada', vramGb: 48, precision: 'int8', priceUsdHr: 0.84, note: 'int8 weights: slightly less detail; 4K is slow.' },
  { id: 'NVIDIA L40', name: 'L40', vramGb: 48, precision: 'int8', priceUsdHr: 0.82, note: 'int8 weights: slightly less detail; 4K is slow. Widely available.' },
  { id: 'NVIDIA RTX A6000', name: 'RTX A6000', vramGb: 48, precision: 'int8', priceUsdHr: 0.53, note: 'int8 weights, older and slower card.' },
  { id: 'NVIDIA A40', name: 'A40', vramGb: 48, precision: 'int8', priceUsdHr: 0.49, note: 'int8 weights, older and slower card. Cheapest, widely available.' },
  { id: 'NVIDIA GeForce RTX 5090', name: 'RTX 5090', vramGb: 32, precision: 'int8', priceUsdHr: 0.99, note: 'int8 weights; up to ~10 s at 1080p, 4K very slow.' },
]

export const DEFAULT_GPU_IDS: readonly string[] = [LTX_GPUS[0]!.id]

export const ltxGpu = (id: string): LtxGpu | undefined => LTX_GPUS.find((g) => g.id === id)

export const precisionFor = (vramGb: number): GpuPrecision => (vramGb >= 78 ? 'bf16' : 'int8')

/** Network volume size the setup needs: bf16 + int8 LTX-2.5 sets, LoRAs, ComfyUI and room for renders. */
export const RECOMMENDED_VOLUME_GB = 150
/** RunPod network volume price (USD per GB-month, first TB). */
export const VOLUME_USD_PER_GB_MONTH = 0.07
/** High-performance network volumes (some data centers offer only these). */
export const HP_VOLUME_USD_PER_GB_MONTH = 0.14

export interface RunpodSettings {
  /** The network volume pods mount at /workspace ('' until one is chosen). Its data center pins the pods. */
  volumeId: string
  /** GPUs tried in this order when a session starts; when none is free the app asks. */
  gpuIds: string[]
  /** Stop the GPU this many seconds after the queue runs empty (nothing rendering or waiting). */
  idleSeconds: number
  /** How long "Keep on" holds the GPU. */
  keepOnMinutes: number
  /** Hard cap: the pod stops itself after this many hours, even if the app is gone. */
  maxHours: number
}

export const DEFAULT_RUNPOD_SETTINGS: RunpodSettings = {
  volumeId: '',
  gpuIds: [...DEFAULT_GPU_IDS],
  idleSeconds: 30,
  keepOnMinutes: 30,
  maxHours: 8,
}

/** The idle stops offered in Settings, in seconds. */
export const IDLE_STOP_CHOICES = [30, 120, 300, 600] as const

/** "30 s", "2 min": how long an idle GPU waits before it stops. */
export const idleText = (seconds: number) => (seconds < 60 || seconds % 60 ? `${seconds} s` : `${seconds / 60} min`)

const VOLUME_ID = /^[a-z0-9]{1,64}$/i

const clampInt = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback

/** Settings read from disk (or a request), repaired to something usable. */
export function sanitizeRunpodSettings(raw: unknown, base: RunpodSettings = DEFAULT_RUNPOD_SETTINGS): RunpodSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<RunpodSettings>
  const volumeId = typeof r.volumeId === 'string' && (r.volumeId === '' || VOLUME_ID.test(r.volumeId)) ? r.volumeId : base.volumeId
  const gpuIds = Array.isArray(r.gpuIds)
    ? [...new Set(r.gpuIds.filter((id): id is string => typeof id === 'string' && Boolean(ltxGpu(id))))]
    : base.gpuIds
  return {
    volumeId,
    gpuIds: gpuIds.length ? gpuIds : [...DEFAULT_GPU_IDS],
    // Older settings kept whole minutes (idleMinutes, 5 by default); they start over at the 30 s default.
    idleSeconds: clampInt(r.idleSeconds, 15, 7200, base.idleSeconds),
    keepOnMinutes: clampInt(r.keepOnMinutes, 5, 240, base.keepOnMinutes),
    maxHours: clampInt(r.maxHours, 1, 24, base.maxHours),
  }
}

// ---------------------------------------------------------------- API shapes (server ↔ client)

export type GpuAvailability = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE'

export interface RunpodVolumeDTO {
  id: string
  name: string
  sizeGb: number
  dataCenter: string
  /** Prepared for LTX-2.5 by this app (setup finished, current version). */
  prepared?: boolean
}

export interface RunpodDatacenterDTO {
  id: string
  name: string
  region?: string
  /** LTX-capable GPUs in stock there (best first). */
  gpus: { id: string; name: string; availability: GpuAvailability }[]
  /** The volume tier the app creates there: standard when offered, else high-performance (twice the price). */
  volumeType?: 'STANDARD' | 'HIGH_PERFORMANCE'
  volumeUsdPerGbMonth?: number
}

export interface RunpodAccountDTO {
  balanceUsd?: number
  spendPerHrUsd?: number
}

export interface CreateVolumeRequest {
  name: string
  sizeGb: number
  dataCenter: string
  /** Standard unless the data center offers only high-performance volumes. */
  type?: 'STANDARD' | 'HIGH_PERFORMANCE'
}

// ---------------------------------------------------------------- the GPU session (one pod at a time)

/**
 * off → creating → booting → ready → stopping → off. `needs_choice`: none of the chosen GPUs was free — the user
 * picks another (or declines). `error`: the last start failed (`fatal` when retrying cannot help, e.g. no credit).
 */
export type GpuSessionState = 'off' | 'creating' | 'booting' | 'ready' | 'stopping' | 'needs_choice' | 'error'

export interface GpuChoiceDTO {
  id: string
  name: string
  vramGb: number
  precision: GpuPrecision
  priceUsdHr: number
  availability: GpuAvailability
  note?: string
}

export interface GpuSessionDTO {
  state: GpuSessionState
  /** What is happening, in words ("Loading ComfyUI…", the error). */
  detail?: string
  fatal?: boolean
  podId?: string
  gpu?: { id: string; name: string; vramGb: number; precision: GpuPrecision }
  costPerHrUsd?: number
  startedAt?: string
  readyAt?: string
  /** Billed so far in this session. */
  costUsd?: number
  /** Renders queued or running on it. */
  busy: boolean
  /** When it stops by itself if nothing else comes (only while ready and idle). */
  idleStopAt?: string
  /** "Keep on" holds it until then. */
  keepUntil?: string
  /** Someone is using ComfyUI on it (clicks, keys): that holds it until then. */
  comfyUntil?: string
  choices?: GpuChoiceDTO[]
  /** The user chose to wait for their first-choice GPU: it is tried again every minute, no other is offered. */
  waitingFor?: string
  /** The chosen network volume and whether it has been prepared. */
  volume?: { id: string; name: string; dataCenter: string; prepared: boolean }
}

// ---------------------------------------------------------------- ComfyUI on the GPU (through the app's local proxy)

/**
 * What happens to the outputs of prompts queued from the ComfyUI page: nothing, saved to the project's Assets, or also
 * appended to the timeline / inserted at the playhead (when that project is open in the editor).
 */
export type ComfyImportMode = 'off' | 'assets' | 'append' | 'insert'
export const COMFY_IMPORT_MODES: readonly ComfyImportMode[] = ['off', 'assets', 'append', 'insert']

export interface ComfyTarget {
  /** The project that receives the outputs. */
  projectId?: string
  mode: ComfyImportMode
}

export interface ComfyViewDTO {
  /** The local address that serves the pod's ComfyUI (the app adds the access token; it never reaches the page). */
  url: string
  target: ComfyTarget
  /** Prompts queued from ComfyUI whose outputs are still to be saved. */
  pendingImports: number
}

/** Preparing a volume: a cheap pod installs ComfyUI, nodes and models onto it, then goes away. */
export type VolumeSetupState = 'idle' | 'creating' | 'running' | 'done' | 'failed'

export interface VolumeSetupDTO {
  state: VolumeSetupState
  volumeId?: string
  podId?: string
  gpuName?: string
  costPerHrUsd?: number
  startedAt?: string
  step?: number
  totalSteps?: number
  title?: string
  /** The last progress lines from the pod. */
  lines: string[]
  error?: string
}
