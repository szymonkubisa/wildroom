import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ALL_FORMATS, FilePathSource, Input } from 'mediabunny'
import { nanoid } from 'nanoid'
import { defaultValues } from '../../src/shared/models/params'
import { getModel } from '../../src/shared/models/registry'
import { loadEnv, type Env } from '../../src/server/env'
import type { JobContext, ProviderAdapter, ProviderOutput } from '../../src/server/providers/types'
import { EventBus } from '../../src/server/services/events'
import { runFfmpeg } from '../../src/server/services/ffmpeg'
import { AppState } from '../../src/server/storage/appState'
import { DerivedCache } from '../../src/server/storage/derivedCache'
import type { ProjectStore } from '../../src/server/storage/projectStore'
import { ProjectRegistry } from '../../src/server/storage/registry'

// ---------------------------------------------------------------------------------------------
// A/V sync analysis (reusable for proxies, wavs and exported renders)
// ---------------------------------------------------------------------------------------------

/**
 * Times (seconds, ffmpeg's timeline of the file) of video frames whose mean luma is above `threshold`
 * (0–255) — the white flash frames of the mock-video sync pattern. Uses showinfo's per-frame plane means.
 */
export async function detectFlashes(videoPath: string, opts: { threshold?: number } = {}): Promise<number[]> {
  const threshold = opts.threshold ?? 200
  const { stderr } = await runFfmpeg(['-i', videoPath, '-map', '0:v:0', '-vf', 'showinfo', '-f', 'null', '-'])
  const flashes: number[] = []
  for (const line of stderr.split('\n')) {
    const m = /\bn:\s*\d+\s+pts:\s*-?\d+\s+pts_time:(\S+).*?\bmean:\[(\d+)/.exec(line)
    if (m && Number(m[2]) >= threshold) flashes.push(Number(m[1]))
  }
  return flashes
}

/**
 * Onset times (seconds) of tones separated by silence in the first audio stream, via ffmpeg's silencedetect.
 * An onset is where a silence ends; audio that starts loud counts as an onset at its first sample.
 */
export async function detectBeeps(mediaPath: string, opts: { noiseDb?: number; minSilence?: number } = {}): Promise<number[]> {
  const noise = opts.noiseDb ?? -30
  const minSilence = opts.minSilence ?? 0.02
  const { stderr } = await runFfmpeg([
    '-i',
    mediaPath,
    '-map',
    '0:a:0',
    '-af',
    `silencedetect=n=${noise}dB:d=${minSilence}`,
    '-f',
    'null',
    '-',
  ])
  const events = [...stderr.matchAll(/silence_(start|end):\s*(-?[\d.e+-]+)/g)].map((m) => ({ kind: m[1]!, time: Number(m[2]) }))
  const end = await audioEndTime(mediaPath)
  const onsets: number[] = []
  const first = events[0]
  if (!first || (first.kind === 'start' && first.time > 1e-4)) onsets.push(0)
  for (const e of events) {
    // silencedetect closes a trailing silence at end-of-stream; that is not an onset.
    if (e.kind === 'end' && e.time < end - 1e-3) onsets.push(e.time)
  }
  return onsets
}

async function audioEndTime(path: string): Promise<number> {
  const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(path) })
  try {
    const track = await input.getPrimaryAudioTrack()
    return track ? await track.computeDuration() : Number.POSITIVE_INFINITY
  } finally {
    input.dispose()
  }
}

export interface AvSyncReport {
  flashes: number[]
  beeps: number[]
  /** beep − nearest flash, per beep (seconds). Positive = audio late. */
  offsets: number[]
  medianOffset: number
  maxAbsOffset: number
}

/** Pairs every beep with the nearest flash. `audioPath` defaults to the video file itself (muxed audio). */
export async function measureAvSync(videoPath: string, audioPath: string = videoPath): Promise<AvSyncReport> {
  const [flashes, beeps] = await Promise.all([detectFlashes(videoPath), detectBeeps(audioPath)])
  const offsets = beeps.map((b) => {
    let best = Number.POSITIVE_INFINITY
    for (const f of flashes) if (Math.abs(b - f) < Math.abs(best)) best = b - f
    return best
  })
  const sorted = [...offsets].sort((a, b) => a - b)
  const medianOffset = sorted.length ? sorted[Math.floor(sorted.length / 2)]! : Number.NaN
  const maxAbsOffset = offsets.reduce((m, o) => Math.max(m, Math.abs(o)), 0)
  return { flashes, beeps, offsets, medianOffset, maxAbsOffset }
}

// ---------------------------------------------------------------------------------------------
// Test library + mock generation helpers
// ---------------------------------------------------------------------------------------------

export interface TestHome {
  /** Root of the throwaway home (app data, cache, projects); free space for fixtures too. */
  dir: string
  env: Env
  appState: AppState
  registry: ProjectRegistry
  cache: DerivedCache
  events: EventBus
  /** Creates (and opens) a project bundle in the home's projects folder. */
  project(name?: string): ProjectStore
  dispose(): Promise<void>
}

/** A throwaway studio home under tests/.tmp: app state, project registry, derived cache, event bus. */
export async function createTestHome(prefix = 'media'): Promise<TestHome> {
  const root = resolve('tests/.tmp')
  await mkdir(root, { recursive: true })
  const dir = await mkdtemp(join(root, `${prefix}-`))
  const env = loadEnv({ home: dir })
  const appState = new AppState(env)
  const events = new EventBus()
  const registry = new ProjectRegistry({ env, appState, events })
  const cache = new DerivedCache(env)
  return {
    dir,
    env,
    appState,
    registry,
    cache,
    events,
    project: (name = 'Test project') => registry.create({ name }),
    async dispose() {
      registry.closeAll()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

export function mockJobContext(env: Env, modelId: string, params: Record<string, unknown> = {}, variant = 0): JobContext {
  const model = getModel(modelId)
  if (!model) throw new Error(`Unknown model ${modelId}`)
  return {
    generationId: `gen-${nanoid(6)}`,
    model,
    params: { ...defaultValues(model), ...params },
    inputs: {},
    credentials: {},
    providerMeta: {},
    variant,
    tmpDir: join(env.tmpDir, 'jobs', nanoid(8)),
    signal: new AbortController().signal,
    recordRequest: () => {},
  }
}

/** submit() + poll() until done, like the job worker does. */
export async function runMockJob(adapter: ProviderAdapter, ctx: JobContext, timeoutMs = 20_000): Promise<ProviderOutput[]> {
  const submitted = await adapter.submit(ctx)
  if (submitted.type === 'done') return submitted.outputs
  ctx.providerTaskId = submitted.taskId
  return pollUntilDone(adapter, ctx, timeoutMs)
}

export async function pollUntilDone(adapter: ProviderAdapter, ctx: JobContext, timeoutMs = 20_000): Promise<ProviderOutput[]> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await adapter.poll!(ctx)
    if (result.type === 'done') return result.outputs
    if (result.type === 'failed') throw new Error(`${result.error.code}: ${result.error.message}`)
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error('mock job timed out')
}

export function filePath(output: ProviderOutput): string {
  if (output.kind !== 'file') throw new Error(`expected a file output, got ${output.kind}`)
  return output.path
}
