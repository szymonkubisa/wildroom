import { fileToBlob, readText } from '../http'

/**
 * ComfyUI on a render pod, reached through RunPod's HTTPS proxy and the pod's token gate (Caddy). Every call is a
 * short request: the proxy cuts anything that runs past 100 s, so renders are queued and polled, never awaited.
 */

export type ComfyFailure = 'unauthorized' | 'starting' | 'unreachable' | 'rejected' | 'server'

export class ComfyError extends Error {
  constructor(
    public readonly kind: ComfyFailure,
    message: string,
    public readonly status?: number,
  ) {
    super(message)
    this.name = 'ComfyError'
  }
}

export interface ComfySystemStats {
  comfyuiVersion?: string
  devices: { name: string; vramTotal?: number; vramFree?: number }[]
}

export interface ComfyQueue {
  running: string[]
  pending: string[]
}

export interface ComfyFile {
  filename: string
  subfolder: string
  type: string
}

export interface ComfyHistoryEntry {
  outputs: Record<string, Record<string, unknown>>
  status?: { status_str?: string; completed?: boolean; messages?: [string, Record<string, unknown>][] }
}

export interface ComfyClientOptions {
  baseUrl: string
  token: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export class ComfyClient {
  private readonly fetchImpl: typeof fetch

  constructor(private readonly opts: ComfyClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  get baseUrl() {
    return this.opts.baseUrl
  }

  /** Headers for downloading files (`/api/view`) through the token gate. */
  get authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${this.opts.token}` }
  }

  async systemStats(): Promise<ComfySystemStats> {
    const body = (await this.json('GET', '/api/system_stats')) as {
      system?: { comfyui_version?: string }
      devices?: { name?: string; vram_total?: number; vram_free?: number }[]
    }
    return {
      comfyuiVersion: body?.system?.comfyui_version,
      devices: (body?.devices ?? []).map((d) => ({ name: d.name ?? 'GPU', vramTotal: d.vram_total, vramFree: d.vram_free })),
    }
  }

  /** Prompt ids running and waiting, in order. */
  async queue(): Promise<ComfyQueue> {
    const body = (await this.json('GET', '/api/queue')) as { queue_running?: unknown[][]; queue_pending?: unknown[][] }
    const ids = (list: unknown[][] | undefined) => (list ?? []).map((item) => String(item?.[1] ?? '')).filter(Boolean)
    const pending = (body?.queue_pending ?? []).slice().sort((a, b) => Number(a?.[0] ?? 0) - Number(b?.[0] ?? 0))
    return { running: ids(body?.queue_running), pending: ids(pending) }
  }

  /** Queues an API-format graph; `clientId` routes its progress events to that websocket client. */
  async prompt(graph: Record<string, unknown>, clientId: string): Promise<string> {
    const body = (await this.json('POST', '/api/prompt', { prompt: graph, client_id: clientId })) as {
      prompt_id?: string
      error?: unknown
      node_errors?: unknown
    }
    if (!body?.prompt_id) throw new ComfyError('rejected', `ComfyUI rejected the workflow: ${describeError(body)}`)
    return body.prompt_id
  }

  /** The finished (or failed) prompt, or undefined while it has not finished. */
  async history(promptId: string): Promise<ComfyHistoryEntry | undefined> {
    const body = (await this.json('GET', `/api/history/${encodeURIComponent(promptId)}`)) as Record<string, ComfyHistoryEntry> | undefined
    return body?.[promptId]
  }

  /** Uploads an input file into ComfyUI's top-level input folder (what Load Image/Video lists). */
  async upload(path: string, mime: string, name: string): Promise<ComfyFile> {
    const form = new FormData()
    form.set('image', await fileToBlob(path, mime), name)
    form.set('type', 'input')
    form.set('overwrite', 'true')
    const res = await this.send('POST', '/api/upload/image', form)
    const body = await this.read(res)
    const r = body as { name?: string; subfolder?: string; type?: string }
    if (!r?.name) throw new ComfyError('server', 'ComfyUI did not accept the upload')
    return { filename: r.name, subfolder: r.subfolder ?? '', type: r.type ?? 'input' }
  }

  async interrupt(promptId?: string): Promise<void> {
    await this.json('POST', '/api/interrupt', promptId ? { prompt_id: promptId } : {})
  }

  async deleteQueued(promptIds: string[]): Promise<void> {
    await this.json('POST', '/api/queue', { delete: promptIds })
  }

  /** Tells the pod's watchdog the app is still there. */
  async heartbeat(): Promise<void> {
    const res = await this.send('GET', '/wildroom/heartbeat')
    if (res.status === 401) throw new ComfyError('unauthorized', 'The GPU rejected the access token', 401)
    if (!res.ok && res.status !== 204) throw failureFor(res.status, await readText(res))
  }

  async objectInfo(nodeClass: string): Promise<Record<string, unknown> | undefined> {
    const body = (await this.json('GET', `/api/object_info/${encodeURIComponent(nodeClass)}`)) as Record<string, unknown> | undefined
    return body?.[nodeClass] as Record<string, unknown> | undefined
  }

  viewUrl(file: ComfyFile): string {
    const q = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder, type: file.type })
    return `${this.opts.baseUrl}/api/view?${q}`
  }

  // ---------------------------------------------------------------- transport

  private async json(method: string, path: string, body?: unknown): Promise<unknown> {
    return this.read(await this.send(method, path, body === undefined ? undefined : JSON.stringify(body), body !== undefined))
  }

  private async read(res: Response): Promise<unknown> {
    const text = await readText(res, 4_000_000)
    if (!res.ok) throw failureFor(res.status, text, res.headers.get('server'))
    if (!text) return undefined
    try {
      return JSON.parse(text)
    } catch {
      // A proxy error page instead of ComfyUI's JSON: the pod is not serving yet.
      throw new ComfyError('starting', 'The GPU is still starting')
    }
  }

  private async send(method: string, path: string, body?: BodyInit, isJson = false): Promise<Response> {
    const signal = AbortSignal.timeout(this.opts.timeoutMs ?? 30_000)
    try {
      return await this.fetchImpl(`${this.opts.baseUrl}${path}`, {
        method,
        headers: { ...this.authHeaders, ...(isJson ? { 'content-type': 'application/json' } : {}) },
        body,
        signal,
      })
    } catch (err) {
      throw new ComfyError('unreachable', `Cannot reach the GPU: ${signal.aborted ? 'no answer' : err instanceof Error ? err.message : String(err)}`)
    }
  }
}

/**
 * What a failed answer means. 401 = wrong token. Through RunPod's proxy, 404 (port not mapped yet), 502 (nothing
 * listening, e.g. Caddy up but ComfyUI loading) and 530/521/522/523 (pod gone or booting) mean "not there yet".
 */
export function failureFor(status: number, body: string, server?: string | null): ComfyError {
  if (status === 401 || status === 403) return new ComfyError('unauthorized', 'The GPU rejected the access token', status)
  if (status === 404 || status === 502 || status === 503 || (status >= 520 && status <= 530)) {
    return new ComfyError('starting', server?.toLowerCase().includes('caddy') ? 'ComfyUI is loading' : 'The GPU is still starting', status)
  }
  if (status === 400) return new ComfyError('rejected', `ComfyUI rejected the request: ${describeError(safeJson(body)) || body.slice(0, 300)}`, status)
  return new ComfyError('server', `ComfyUI error ${status}${body ? `: ${body.slice(0, 300)}` : ''}`, status)
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** ComfyUI's validation errors ({error:{message}, node_errors:{id:{errors:[{message, details}]}}}) as one line. */
function describeError(body: unknown): string {
  const b = body as { error?: { message?: string } | string; node_errors?: Record<string, { errors?: { message?: string; details?: string }[]; class_type?: string }> }
  const parts: string[] = []
  if (typeof b?.error === 'string') parts.push(b.error)
  else if (b?.error?.message) parts.push(b.error.message)
  for (const [id, node] of Object.entries(b?.node_errors ?? {})) {
    for (const e of node.errors ?? []) parts.push(`${node.class_type ?? id}: ${e.message ?? ''}${e.details ? ` (${e.details})` : ''}`)
  }
  return parts.join('; ').slice(0, 500)
}
