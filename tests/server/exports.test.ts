import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Hono } from 'hono'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AppDeps } from '../../src/server/app'
import { ApiError } from '../../src/server/http'
import { exportRoutes } from '../../src/server/routes/exports'

let root: string

beforeAll(async () => {
  mkdirSync('tests/.tmp', { recursive: true })
  root = resolve(await mkdtemp(join('tests/.tmp', 'exports-')))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('export sessions', () => {
  it('drops an export nothing was sent for in half an hour, releasing its project and its frames', async () => {
    // Only the interval and the clock: the files are real.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    const held: string[] = []
    const released: string[] = []
    const deps = {
      env: { tmpDir: join(root, 'Tmp') },
      registry: {
        require: (id: string) => ({ id }),
        hold: (id: string) => {
          held.push(id)
          return () => released.push(id)
        },
      },
      events: { publish: () => {} },
    } as unknown as AppDeps
    const r = new Hono()
    r.onError((err, c) => c.json({ error: err.message }, err instanceof ApiError ? err.status : 500))
    r.route('/', exportRoutes(deps))
    const json = { 'content-type': 'application/json' }
    const res = await r.request('/exports', { method: 'POST', headers: json, body: JSON.stringify({ projectId: 'p1', fps: 24, frames: 48 }) })
    expect(res.status).toBe(201)
    const { id } = (await res.json()) as { id: string }
    expect(held).toEqual(['p1'])
    const chunk = () => r.request(`/exports/${id}/video?position=0`, { method: 'PUT', body: new Uint8Array([1, 2, 3]) })

    // Still being sent: kept.
    vi.advanceTimersByTime(25 * 60_000)
    expect((await chunk()).status).toBe(200)
    vi.advanceTimersByTime(25 * 60_000)
    expect(released).toEqual([])

    // The tab went away mid-export.
    vi.advanceTimersByTime(10 * 60_000)
    expect(released).toEqual(['p1'])
    await new Promise((done) => setTimeout(done, 50))
    expect(existsSync(join(root, 'Tmp', 'exports', id))).toBe(false)
    expect(readdirSync(join(root, 'Tmp', 'exports'))).toEqual([])
    expect((await chunk()).status).toBe(404)
  })
})
