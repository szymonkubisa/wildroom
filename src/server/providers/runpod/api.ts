import type { GpuAvailability } from '../../../shared/types/runpod'
import { readText } from '../http'

/** RunPod REST v2 (pods, volumes, catalog) plus the one GraphQL query v2 lacks (account balance). */

export const RUNPOD_API = 'https://api.runpod.io/v2'
export const RUNPOD_GRAPHQL = 'https://api.runpod.io/graphql'
const LABEL = 'RunPod'

export type RunpodErrorKind = 'auth' | 'balance' | 'forbidden' | 'not_found' | 'rejected' | 'invalid' | 'rate_limited' | 'server' | 'network'

/** A failed RunPod call, classified so callers can decide (try the next GPU, stop, wait). */
export class RunpodError extends Error {
  constructor(
    public readonly kind: RunpodErrorKind,
    message: string,
    public readonly status?: number,
    public readonly retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'RunpodError'
  }
}

export interface RunpodVolume {
  id: string
  name: string
  size: number
  dataCenter: string
  type?: string
}

export type PodStatus = 'PROVISIONING' | 'STARTING' | 'RUNNING' | 'EXITED' | 'TERMINATED' | 'ERROR' | (string & {})

export interface RunpodPod {
  id: string
  name: string
  status: PodStatus
  /** USD per hour while running (0 once exited). */
  cost?: number
  dataCenterId?: string
  gpu?: { id?: string; count?: number; memory?: number }
  env?: Record<string, string>
  createdAt?: string
  startedAt?: string
  runtime?: { uptime?: number } | null
}

export interface CreatePodBody {
  name: string
  image: string
  /** Exactly one of `gpu` or `cpu`. */
  gpu?: { id: string; count: number; minCudaVersion?: string }
  cpu?: { id: string; vcpuCount: number }
  cloud: 'SECURE' | 'COMMUNITY'
  dataCenterIds: string[]
  mounts: { network: { volumeId: string; path: string }[] }
  /** Ephemeral container disk, GB. */
  disk: number
  ports: string[]
  env: Record<string, string>
  entrypoint?: string[]
  cmd?: string[]
}

export interface RunpodDatacenter {
  id: string
  name: string
  region?: string
  /** Network volume tiers offered there (STANDARD, HIGH_PERFORMANCE); empty = no network volumes. */
  networkVolumeTypes: string[]
  gpuAvailability: { id: string; name?: string; availability: GpuAvailability }[]
}

/** A GPU type with its stock (overall and per data center) on hosts that meet the CUDA filter. */
export interface RunpodGpuStock {
  id: string
  name: string
  memoryGb?: number
  priceSecure?: number
  availability: GpuAvailability
  dataCenters: { id: string; availability: GpuAvailability }[]
}

/** A CPU flavor with its price and stock in one data center. */
export interface RunpodCpuStock {
  id: string
  name: string
  vcpuMin: number
  vcpuMax: number
  ramGbPerVcpu: number
  pricePerVcpu: number
  availability: GpuAvailability
}

export interface RunpodAccount {
  clientBalance?: number
  currentSpendPerHr?: number
}

export interface RunpodApiOptions {
  apiKey: string
  fetchImpl?: typeof fetch
  baseUrl?: string
  graphqlUrl?: string
  timeoutMs?: number
}

export class RunpodApi {
  private readonly fetchImpl: typeof fetch
  private readonly baseUrl: string
  private readonly graphqlUrl: string

  constructor(private readonly opts: RunpodApiOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.baseUrl = opts.baseUrl ?? RUNPOD_API
    this.graphqlUrl = opts.graphqlUrl ?? RUNPOD_GRAPHQL
  }

  // ---------------------------------------------------------------- volumes

  async listVolumes(): Promise<RunpodVolume[]> {
    const body = await this.request<unknown>('GET', '/network-volumes')
    return listOf(body, 'networkVolumes').map(toVolume).filter((v): v is RunpodVolume => Boolean(v))
  }

  async getVolume(id: string): Promise<RunpodVolume> {
    const volume = toVolume(await this.request<unknown>('GET', `/network-volumes/${encodeURIComponent(id)}`))
    if (!volume) throw new RunpodError('not_found', `${LABEL}: network volume ${id} not found`, 404)
    return volume
  }

  async createVolume(input: { name: string; size: number; dataCenter: string; type?: 'STANDARD' | 'HIGH_PERFORMANCE' }): Promise<RunpodVolume> {
    const volume = toVolume(await this.request<unknown>('POST', '/network-volumes', input))
    if (!volume) throw new RunpodError('server', `${LABEL}: unexpected answer when creating the volume`)
    return volume
  }

  // ---------------------------------------------------------------- catalog

  /** Data centers with per-GPU stock (HIGH/MEDIUM/LOW/NONE). Stock is a hint, not a reservation. */
  async datacenters(): Promise<RunpodDatacenter[]> {
    const body = await this.request<unknown>('GET', '/catalog/datacenters?include=GPU_AVAILABILITY')
    return listOf(body, 'dataCenters').map(toDatacenter).filter((d): d is RunpodDatacenter => Boolean(d))
  }

  /** Pod stock of every GPU type on Secure Cloud hosts with at least this CUDA version (what our image needs). */
  async gpuStock(minCudaVersion: string): Promise<RunpodGpuStock[]> {
    const query = new URLSearchParams({ include: 'AVAILABILITY', product: 'POD', cloud: 'SECURE', minCudaVersion })
    const body = await this.request<unknown>('GET', `/catalog/gpus?${query}`)
    return listOf(body, 'gpus').map(toGpuStock).filter((g): g is RunpodGpuStock => Boolean(g))
  }

  /** Stock of each GPU type in one data center on hosts with at least `minCudaVersion` (falls back to the data center's own view). */
  async stockIn(dataCenter: string, minCudaVersion: string): Promise<Map<string, GpuAvailability>> {
    try {
      const stock = new Map<string, GpuAvailability>()
      for (const g of await this.gpuStock(minCudaVersion)) {
        const here = g.dataCenters.find((d) => d.id === dataCenter)
        if (here) stock.set(g.id, here.availability)
      }
      return stock
    } catch {
      return new Map((await this.datacenter(dataCenter)).gpuAvailability.map((g) => [g.id, g.availability]))
    }
  }

  /** CPU flavors offered in a data center, with stock for pods of `vcpuCount` vCPUs. */
  async cpuStockIn(dataCenter: string, vcpuCount: number): Promise<RunpodCpuStock[]> {
    const query = new URLSearchParams({ include: 'AVAILABILITY', product: 'POD', vcpuCount: String(vcpuCount) })
    const body = await this.request<unknown>('GET', `/catalog/cpus?${query}`)
    return listOf(body, 'cpus').flatMap((raw) => {
      const r = raw as Record<string, unknown> | null
      const id = str(r?.id)
      const vcpu = r?.vcpu as Record<string, unknown> | undefined
      const price = r?.price as Record<string, unknown> | undefined
      const here = (Array.isArray(r?.dataCenters) ? (r!.dataCenters as Record<string, unknown>[]) : []).find((d) => d.id === dataCenter)
      if (!id || !here) return []
      return [
        {
          id,
          name: str(r!.name) ?? id,
          vcpuMin: num(vcpu?.min) ?? 2,
          vcpuMax: num(vcpu?.max) ?? 2,
          ramGbPerVcpu: num(r!.ramGbPerVcpu) ?? 0,
          pricePerVcpu: num(price?.securePerVcpu) ?? 0,
          availability: level(here.availability),
        },
      ]
    })
  }

  async datacenter(id: string): Promise<RunpodDatacenter> {
    const dc = toDatacenter(await this.request<unknown>('GET', `/catalog/datacenters/${encodeURIComponent(id)}?include=GPU_AVAILABILITY`))
    if (!dc) throw new RunpodError('not_found', `${LABEL}: data center ${id} not found`, 404)
    return dc
  }

  // ---------------------------------------------------------------- pods

  async createPod(body: CreatePodBody): Promise<RunpodPod> {
    const pod = toPod(await this.request<unknown>('POST', '/pods', body))
    if (!pod) throw new RunpodError('server', `${LABEL}: unexpected answer when creating the pod`)
    return pod
  }

  /** The pod, or undefined once it no longer exists. */
  async getPod(id: string): Promise<RunpodPod | undefined> {
    try {
      return toPod(await this.request<unknown>('GET', `/pods/${encodeURIComponent(id)}`)) ?? undefined
    } catch (err) {
      if (err instanceof RunpodError && err.kind === 'not_found') return undefined
      throw err
    }
  }

  /** Terminates the pod (its network volume is only detached). Already gone counts as done. */
  async deletePod(id: string): Promise<void> {
    try {
      await this.request<unknown>('DELETE', `/pods/${encodeURIComponent(id)}`)
    } catch (err) {
      if (err instanceof RunpodError && err.kind === 'not_found') return
      throw err
    }
  }

  async listPods(): Promise<RunpodPod[]> {
    const pods: RunpodPod[] = []
    let cursor: string | undefined
    for (let page = 0; page < 20; page++) {
      const query = new URLSearchParams({ limit: '1000' })
      if (cursor) query.set('cursor', cursor)
      const body = await this.request<unknown>('GET', `/pods?${query}`)
      pods.push(...listOf(body, 'pods').map(toPod).filter((p): p is RunpodPod => Boolean(p)))
      const next = (body as { pagination?: { nextCursor?: string; hasNextPage?: boolean } } | null)?.pagination
      if (!next?.hasNextPage || !next.nextCursor) break
      cursor = next.nextCursor
    }
    return pods
  }

  // ---------------------------------------------------------------- account

  /** REST v2 has no balance endpoint; runpodctl reads it over GraphQL too. */
  async account(): Promise<RunpodAccount> {
    const data = await this.graphql<{ myself?: RunpodAccount }>('{ myself { clientBalance currentSpendPerHr } }')
    const me = data?.myself ?? {}
    return { clientBalance: num(me.clientBalance), currentSpendPerHr: num(me.currentSpendPerHr) }
  }

  /**
   * How long the pod's container has been running, in seconds; null while there is no container yet (the machine is
   * still downloading the image or starting it). The REST pod only has the status it should have ("RUNNING" from the
   * moment it is rented), so this comes from GraphQL.
   */
  async podUptime(id: string): Promise<number | null> {
    const data = await this.graphql<{ pod?: { runtime?: { uptimeInSeconds?: unknown } | null } | null }>(
      `{ pod(input: { podId: ${JSON.stringify(id)} }) { id runtime { uptimeInSeconds } } }`,
    )
    return num(data?.pod?.runtime?.uptimeInSeconds) ?? null
  }

  private async graphql<T>(query: string): Promise<T | undefined> {
    const res = await this.send(this.graphqlUrl, 'POST', { query })
    const text = await readText(res)
    if (!res.ok) throw classify(res.status, text, res.headers.get('retry-after'))
    const body = safeJson(text) as { data?: T; errors?: { message?: string }[] } | undefined
    if (body?.errors?.length) {
      const message = body.errors[0]?.message ?? 'GraphQL error'
      throw new RunpodError(/unauthori[sz]ed|api key/i.test(message) ? 'auth' : 'server', `${LABEL}: ${message}`)
    }
    return body?.data
  }

  // ---------------------------------------------------------------- transport

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.send(`${this.baseUrl}${path}`, method, body)
    const text = await readText(res, 1_000_000)
    if (!res.ok) throw classify(res.status, text, res.headers.get('retry-after'))
    return (text ? safeJson(text) : undefined) as T
  }

  private async send(url: string, method: string, body?: unknown): Promise<Response> {
    const signal = AbortSignal.timeout(this.opts.timeoutMs ?? 30_000)
    try {
      return await this.fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${this.opts.apiKey}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      })
    } catch (err) {
      const reason = signal.aborted ? 'no response after 30 s' : err instanceof Error ? err.message : String(err)
      throw new RunpodError('network', `${LABEL}: network error — ${reason}`)
    }
  }
}

/** Maps an HTTP failure (problem+json `{title, detail}` or plain text) to a RunpodError. */
export function classify(status: number, body: string, retryAfter?: string | null): RunpodError {
  const parsed = safeJson(body) as { detail?: unknown; title?: unknown; error?: unknown; message?: unknown } | undefined
  const detail = [parsed?.detail, parsed?.message, parsed?.error, parsed?.title].find((v): v is string => typeof v === 'string' && v.trim() !== '')
  const text = detail ?? body.trim().slice(0, 300)
  const message = `${LABEL}: ${text || `HTTP ${status}`}`
  if (status === 401) return new RunpodError('auth', `${LABEL}: invalid or missing API key${detail ? ` (${detail})` : ''}`, status)
  if (status === 402) return new RunpodError('balance', `${LABEL}: not enough credit${text ? ` (${text})` : ''}`, status)
  if (status === 403) return new RunpodError('forbidden', message, status)
  if (status === 404) return new RunpodError('not_found', message, status)
  if (status === 429) {
    const seconds = Number(retryAfter)
    return new RunpodError('rate_limited', message, status, Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 30_000)
  }
  // 400 is how RunPod says "no instances available with the requested specifications" (and other rule violations).
  if (status === 400) return new RunpodError('rejected', message, status)
  if (status === 422) return new RunpodError('invalid', message, status)
  return new RunpodError('server', message, status)
}

// ---------------------------------------------------------------- parsing (defensive: v2 shapes are young)

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function listOf(body: unknown, key: string): unknown[] {
  if (Array.isArray(body)) return body
  const value = (body as Record<string, unknown> | null | undefined)?.[key]
  return Array.isArray(value) ? value : []
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

function toVolume(raw: unknown): RunpodVolume | undefined {
  const r = raw as Record<string, unknown> | null
  const id = str(r?.id)
  if (!id) return undefined
  return {
    id,
    name: str(r!.name) ?? id,
    size: num(r!.size) ?? 0,
    dataCenter: str(r!.dataCenter) ?? str(r!.dataCenterId) ?? '',
    type: str(r!.type),
  }
}

const AVAILABILITY = new Set(['HIGH', 'MEDIUM', 'LOW', 'NONE'])

function toDatacenter(raw: unknown): RunpodDatacenter | undefined {
  const r = raw as Record<string, unknown> | null
  const id = str(r?.id)
  if (!id) return undefined
  const list = Array.isArray(r!.gpuAvailability) ? (r!.gpuAvailability as Record<string, unknown>[]) : []
  const gpuAvailability: RunpodDatacenter['gpuAvailability'] = []
  for (const g of list) {
    const gid = str(g.id) ?? str(g.gpuTypeId)
    if (!gid) continue
    const availability = String(g.availability ?? g.stockStatus ?? '').toUpperCase()
    gpuAvailability.push({ id: gid, name: str(g.name) ?? str(g.displayName), availability: (AVAILABILITY.has(availability) ? availability : 'NONE') as GpuAvailability })
  }
  const types = Array.isArray(r!.networkVolumeTypes) ? (r!.networkVolumeTypes as unknown[]).filter((t): t is string => typeof t === 'string') : []
  return { id, name: str(r!.name) ?? id, region: str(r!.region), networkVolumeTypes: types, gpuAvailability }
}

const level = (v: unknown): GpuAvailability => {
  const s = String(v ?? '').toUpperCase()
  return (AVAILABILITY.has(s) ? s : 'NONE') as GpuAvailability
}

function toGpuStock(raw: unknown): RunpodGpuStock | undefined {
  const r = raw as Record<string, unknown> | null
  const id = str(r?.id)
  if (!id) return undefined
  const price = r!.price as Record<string, unknown> | undefined
  const dcs = Array.isArray(r!.dataCenters) ? (r!.dataCenters as Record<string, unknown>[]) : []
  return {
    id,
    name: str(r!.name) ?? id,
    memoryGb: num(r!.memory),
    priceSecure: num(price?.secure),
    availability: level(r!.availability),
    dataCenters: dcs.flatMap((d) => (str(d.id) ? [{ id: str(d.id)!, availability: level(d.availability) }] : [])),
  }
}

function toPod(raw: unknown): RunpodPod | undefined {
  const r = raw as Record<string, unknown> | null
  const id = str(r?.id)
  if (!id) return undefined
  const gpu = (r!.gpu ?? undefined) as Record<string, unknown> | undefined
  const env = r!.env && typeof r!.env === 'object' && !Array.isArray(r!.env) ? (r!.env as Record<string, string>) : undefined
  const runtime = r!.runtime && typeof r!.runtime === 'object' ? { uptime: num((r!.runtime as Record<string, unknown>).uptime) } : null
  return {
    id,
    name: str(r!.name) ?? '',
    status: (str(r!.status) ?? str(r!.desiredStatus) ?? 'PROVISIONING').toUpperCase(),
    cost: num(r!.cost) ?? num(r!.costPerHr),
    dataCenterId: str(r!.dataCenterId),
    gpu: gpu ? { id: str(gpu.id), count: num(gpu.count), memory: num(gpu.memory) } : undefined,
    env,
    createdAt: str(r!.createdAt),
    startedAt: str(r!.startedAt),
    runtime,
  }
}
