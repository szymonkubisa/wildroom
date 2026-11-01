import type { CreateGenerationRequest } from '@shared/types/api'
import { type GenerationDTO, TERMINAL_JOB_STATUSES } from '@shared/types/jobs'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { toast } from 'vue-sonner'
import { api } from '@/lib/api'
import { onServerEvent, onServerReconnect } from '@/lib/sse'

type FinishedListener = (generation: GenerationDTO) => void

function isTerminal(job: GenerationDTO) {
  return TERMINAL_JOB_STATUSES.includes(job.status)
}

/** `a` is an older state of the same job than `b` (every save on the server bumps `updatedAt`). */
function older(a: GenerationDTO, b: GenerationDTO | undefined): boolean {
  return Boolean(b && a.updatedAt < b.updatedAt)
}

/** Finished jobs kept for the queue panel's history (the server's worker remembers as many). */
const RECENT_MAX = 100

/** When a job finished (its last change, for older records). */
const doneAt = (job: GenerationDTO) => job.finishedAt ?? job.updatedAt

/** The order the worker takes queued jobs in. */
function byQueueOrder(jobs: GenerationDTO[]): GenerationDTO[] {
  const order = (j: GenerationDTO) => j.queueOrder ?? Date.parse(j.createdAt)
  return jobs.sort((a, b) => order(a) - order(b) || (a.createdAt < b.createdAt ? -1 : 1))
}

/**
 * Generation jobs of the open project, live via SSE, plus every project's queued and running jobs and lately finished
 * ones: the worker runs one shared queue (and one GPU) for all projects, and the queue panel shows all of it, also
 * from the projects page.
 */
export const useJobsStore = defineStore('jobs', () => {
  const projectId = ref<string>()
  const byId = ref<Record<string, GenerationDTO>>({})
  const sharedById = ref<Record<string, GenerationDTO>>({})
  /** Every project's finished jobs that the server still remembers (this app run), by id. */
  const recentById = ref<Record<string, GenerationDTO>>({})
  const finishedListeners = new Set<FinishedListener>()

  const list = computed(() => Object.values(byId.value).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)))
  const active = computed(() => list.value.filter((j) => !isTerminal(j)))
  const attention = computed(() => list.value.filter((j) => j.status === 'needs_attention'))
  /** This project's jobs waiting to start, in the order the worker will take them. */
  const queued = computed(() => byQueueOrder(list.value.filter((j) => j.status === 'queued')))
  /** Started and not finished yet. */
  const running = computed(() => active.value.filter((j) => j.status !== 'queued'))
  /** Finished renders, newest first. */
  const history = computed(() =>
    list.value.filter((j) => isTerminal(j)).sort((a, b) => ((a.finishedAt ?? a.updatedAt) < (b.finishedAt ?? b.updatedAt) ? 1 : -1)),
  )
  /** Every project's queued jobs, in the shared order. */
  const sharedQueued = computed(() => byQueueOrder(Object.values(sharedById.value).filter((j) => j.status === 'queued')))
  /** Every project's started, unfinished jobs. */
  const sharedRunning = computed(() => Object.values(sharedById.value).filter((j) => j.status !== 'queued'))
  /** Every project's lately finished jobs, newest first. */
  const sharedHistory = computed(() => Object.values(recentById.value).sort((a, b) => (doneAt(a) < doneAt(b) ? 1 : -1)))
  const sharedAttention = computed(() => sharedHistory.value.filter((j) => j.status === 'needs_attention'))
  /** Project names by id, from the jobs seen (the server names each job's project while it is open). */
  const projectNames = computed(() => {
    const names: Record<string, string> = {}
    for (const job of [...sharedHistory.value, ...Object.values(sharedById.value), ...list.value]) {
      if (job.projectName && !names[job.projectId]) names[job.projectId] = job.projectName
    }
    return names
  })

  /** When jobs left the shared queue (id → updatedAt of their final state), so an older snapshot can't bring them back. */
  const ended = new Map<string, string>()

  /** Keeps the newest finished jobs (as many as the server remembers) and every one that needs attention. */
  function pruneRecent() {
    const all = Object.values(recentById.value)
    if (all.length <= RECENT_MAX) return
    const newest = new Set(all.sort((a, b) => (doneAt(a) < doneAt(b) ? 1 : -1)).slice(0, RECENT_MAX))
    recentById.value = Object.fromEntries(all.filter((j) => newest.has(j) || j.status === 'needs_attention').map((j) => [j.id, j]))
  }

  /** Keeps the shared queue and the shared history current; ignores states older than the one it has. */
  function track(job: GenerationDTO) {
    if (older(job, sharedById.value[job.id]) || older(job, recentById.value[job.id])) return
    if (isTerminal(job)) {
      ended.set(job.id, job.updatedAt)
      delete sharedById.value[job.id]
      recentById.value[job.id] = job
      pruneRecent()
    } else {
      sharedById.value[job.id] = job
      delete recentById.value[job.id]
    }
  }

  /**
   * Stores a job of this project. An API response can be older than a live update that already arrived — the
   * worker can start, or even finish, a job before the request that created it returns — so the newest state wins.
   */
  function upsert(job: GenerationDTO) {
    const prev = byId.value[job.id]
    if (older(job, prev)) return
    byId.value[job.id] = job
    track(job)
    if (isTerminal(job) && (!prev || !isTerminal(prev))) {
      for (const listener of finishedListeners) listener(job)
      if (prev) notify(job)
    }
  }

  function notify(job: GenerationDTO) {
    // Another project's render (the queue is shared): say which project.
    const where = job.projectId !== projectId.value && job.projectName ? `${job.projectName}: ` : ''
    if (job.status === 'succeeded') toast.success('Generation ready', { description: where + job.label })
    else if (job.status === 'failed') toast.error('Generation failed', { description: where + (job.error?.message ?? job.label) })
    else if (job.status === 'needs_attention')
      toast.warning('Generation needs attention', { description: where + (job.error?.message ?? job.label) })
    if (job.status === 'succeeded' && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      new Notification('Wildroom — generation ready', { body: job.label })
    }
  }

  /** `fresh` from a list request, with any newer live update that arrived while it loaded laid over it. */
  function merge(fresh: GenerationDTO[], live: Record<string, GenerationDTO>, keep: (job: GenerationDTO) => boolean) {
    const next = Object.fromEntries(fresh.map((j) => [j.id, j]))
    for (const job of Object.values(live)) if (keep(job) && (!next[job.id] || older(next[job.id]!, job))) next[job.id] = job
    return next
  }

  async function load(id: string) {
    projectId.value = id
    const [jobs] = await Promise.all([api.generations.list(id), loadShared()])
    // Another project opened (or the editor left) while this list loaded: not this project's list any more.
    if (projectId.value !== id) return
    const before = byId.value
    byId.value = merge(jobs, before, (j) => j.projectId === id)
    // Jobs that finished while the stream was down (a reconnect reload): tell listeners, as a live update would.
    for (const job of Object.values(byId.value)) {
      const prev = before[job.id]
      if (prev && !isTerminal(prev) && isTerminal(job)) for (const listener of finishedListeners) listener(job)
    }
  }

  /** Every project's queue and lately finished jobs (the projects page has no project of its own to load). */
  async function loadShared() {
    const [shared, recent] = await Promise.all([api.generations.active(), api.generations.recent()])
    const queue = merge(shared, sharedById.value, () => true)
    for (const job of Object.values(queue)) {
      const end = ended.get(job.id)
      if (isTerminal(job) || (end && end >= job.updatedAt)) delete queue[job.id]
    }
    sharedById.value = queue
    const done = merge(recent, recentById.value, isTerminal)
    for (const job of Object.values(done)) if (!isTerminal(job) || queue[job.id]) delete done[job.id]
    recentById.value = done
    pruneRecent()
  }

  /** The editor left its project: only the shared queue stays. */
  function release() {
    projectId.value = undefined
    byId.value = {}
  }

  async function create(req: CreateGenerationRequest): Promise<GenerationDTO[]> {
    const created = await api.generations.create(req)
    for (const job of created) upsert(job)
    if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission()
    return created
  }

  /** A job from an API answer: the queue panel and the GPU chip act on every project's jobs, only this project's go into its list. */
  function receive(job: GenerationDTO) {
    if (job.projectId === projectId.value) return upsert(job)
    const was = sharedById.value[job.id]
    track(job)
    if (was && isTerminal(job) && !older(job, was)) notify(job)
  }

  async function cancel(id: string) {
    receive(await api.generations.cancel(id))
  }

  async function retry(id: string) {
    receive(await api.generations.retry(id))
  }

  async function move(id: string, to: 'top' | 'up' | 'down' | 'bottom') {
    for (const job of await api.generations.move(id, to)) receive(job)
  }

  function onFinished(listener: FinishedListener) {
    finishedListeners.add(listener)
    return () => finishedListeners.delete(listener)
  }

  onServerEvent((event) => {
    if (event.type === 'generation.upserted') receive(event.generation)
  })
  onServerReconnect(() => {
    void (projectId.value ? load(projectId.value) : loadShared()).catch(() => {})
  })

  return {
    projectId,
    byId,
    list,
    active,
    attention,
    queued,
    running,
    history,
    sharedQueued,
    sharedRunning,
    sharedHistory,
    sharedAttention,
    projectNames,
    load,
    loadShared,
    release,
    create,
    cancel,
    retry,
    move,
    onFinished,
    isTerminal,
  }
})
