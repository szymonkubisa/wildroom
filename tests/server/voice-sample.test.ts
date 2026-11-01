import { mkdirSync, rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type AppDeps, closeDeps, createApp, createDeps } from '../../src/server/app'
import { loadEnv } from '../../src/server/env'
import { VOICE_SAMPLE_SECONDS } from '../../src/server/services/analysis'
import { runFfmpeg } from '../../src/server/services/ffmpeg'
import { MemorySecretStore } from '../../src/server/services/keychain'
import type { AssetDTO } from '../../src/shared/types/assets'
import type { ProjectDetail } from '../../src/shared/types/api'

const ORIGIN = 'http://127.0.0.1:5180'
const HOST = '127.0.0.1:5180'
const FLICKS = 705_600_000

describe('voice sample route', () => {
  let root: string
  let deps: AppDeps
  let app: ReturnType<typeof createApp>
  let project: ProjectDetail

  const req = (method: string, path: string, body?: unknown) =>
    app.request(`http://${HOST}${path}`, {
      method,
      headers: { host: HOST, ...(method !== 'GET' ? { origin: ORIGIN, 'x-studio': '1' } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })

  /** A tone `seconds` long, imported into the project. */
  async function tone(name: string, seconds: number, freq: number): Promise<AssetDTO> {
    const path = join(root, `${name}.mp3`)
    await runFfmpeg(['-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${seconds}`, '-c:a', 'libmp3lame', '-b:a', '128k', path])
    return deps.media.importFile(path, { name, source: 'import', projectId: project.id })
  }

  beforeAll(async () => {
    mkdirSync('tests/.tmp', { recursive: true })
    root = resolve(await mkdtemp(join('tests/.tmp', 'voice-sample-')))
    deps = createDeps(loadEnv({ home: join(root, 'home'), port: 7779 }), { secrets: new MemorySecretStore() })
    app = createApp(deps)
    project = (await (await req('POST', '/api/projects', { name: 'Voices' })).json()) as ProjectDetail
  })

  afterAll(async () => {
    await closeDeps(deps)
    rmSync(root, { recursive: true, force: true })
  })

  it('mixes the line over a quiet bed into one WAV: the speech plus a short tail, both as parents', async () => {
    const speech = await tone('Line', 3, 220)
    const bed = await tone('Rain', 2, 880)
    const res = await req('POST', `/api/projects/${project.id}/voice-sample`, { speechAssetId: speech.id, bedAssetId: bed.id, name: 'Valentina — voice sample' })
    expect(res.status).toBe(201)
    const sample = (await res.json()) as AssetDTO
    expect(sample.mime).toMatch(/wav/)
    expect(sample).toMatchObject({ name: 'Valentina — voice sample', kind: 'audio', source: 'derived', role: 'dialogue', parentIds: [speech.id, bed.id] })
    expect(sample.keywords).toContain('voice-sample')
    // The bed loops under the whole line; 0.3 s after it.
    expect((sample.durationFlicks ?? 0) / FLICKS).toBeCloseTo(3.3, 1)
  })

  it('caps a long line at the sample length, and works without a bed', async () => {
    const speech = await tone('Long line', 9, 220)
    const res = await req('POST', `/api/projects/${project.id}/voice-sample`, { speechAssetId: speech.id })
    expect(res.status).toBe(201)
    const sample = (await res.json()) as AssetDTO
    expect((sample.durationFlicks ?? 0) / FLICKS).toBeCloseTo(VOICE_SAMPLE_SECONDS, 1)
    expect(sample.parentIds).toEqual([speech.id])
  })

  it('needs the speech, and audio', async () => {
    expect((await req('POST', `/api/projects/${project.id}/voice-sample`, {})).status).toBe(400)
    expect((await req('POST', `/api/projects/${project.id}/voice-sample`, { speechAssetId: 'nope' })).status).toBe(404)
  })
})
