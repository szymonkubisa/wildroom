import { mkdirSync, rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type AppDeps, closeDeps, createDeps } from '../../src/server/app'
import { loadEnv } from '../../src/server/env'
import { MemorySecretStore } from '../../src/server/services/keychain'

let root: string
let deps: AppDeps

beforeAll(async () => {
  mkdirSync('tests/.tmp', { recursive: true })
  root = resolve(await mkdtemp(join('tests/.tmp', 'runpod-pause-')))
  const secrets = new MemorySecretStore()
  secrets.set('runpod', 'apiKey', 'rpa_test')
  // The worker and the session are not started, and the session's RunPod is a stub: nothing here can reach RunPod.
  deps = createDeps(loadEnv({ home: join(root, 'home'), port: 7795 }), {
    secrets,
    gpuSession: {
      api: () => {
        throw new Error('no RunPod in tests')
      },
    },
  })
})

afterAll(async () => {
  await closeDeps(deps)
  rmSync(root, { recursive: true, force: true })
})

describe('the rented GPU and a paused queue', () => {
  it('does not count queued RunPod renders as keeping the GPU on while the queue is paused (none of them can start)', () => {
    const projectId = deps.registry.create({ name: 'Paused' }).id
    deps.worker.create({ projectId, modelId: 'runpod-ltx-2.5', params: { prompt: 'a rainy street' }, variants: 1 })
    expect(deps.gpuSession.dto().busy).toBe(true)
    deps.settings.update({ queuePaused: true })
    expect(deps.gpuSession.dto().busy).toBe(false)
    deps.settings.update({ queuePaused: false })
    expect(deps.gpuSession.dto().busy).toBe(true)
  })
})
