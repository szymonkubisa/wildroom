import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { serve, type ServerType } from '@hono/node-server'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type AppDeps, closeDeps, createApp, createDeps } from '../../src/server/app'
import { loadEnv } from '../../src/server/env'
import { checkSpend } from '../../src/server/mcp/costGuard'
import { AppRequests, NotClaimedError } from '../../src/server/services/appRequests'
import { MemorySecretStore } from '../../src/server/services/keychain'
import { MCP_TOKEN_FILE, mcpToken, SERVER_INFO_FILE, writeServerInfo } from '../../src/server/services/mcpAccess'
import { runFfmpeg } from '../../src/server/services/ffmpeg'
import type { McpIntegrationInfo } from '../../src/shared/types/api'

let root: string
let deps: AppDeps
let server: ServerType
let base: string
let token: string

async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const s = createServer()
    s.once('error', fail)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => done(port))
    })
  })
}

type ToolContent = Array<{ type: string; text?: string; data?: string; mimeType?: string }>

async function connect(auth = token) {
  const client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${auth}` } } }))
  return client
}

/** A tool's JSON answer (its first text block), or the error it answered with. */
async function call<T = Record<string, unknown>>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await client.callTool({ name, arguments: args })
  const first = (res.content as ToolContent)[0]
  if (res.isError) throw new Error(first?.text ?? 'tool failed')
  return JSON.parse(first!.text!) as T
}

beforeAll(async () => {
  mkdirSync('tests/.tmp', { recursive: true })
  root = resolve(await mkdtemp(join('tests/.tmp', 'mcp-')))
  const port = await freePort()
  deps = createDeps(loadEnv({ home: join(root, 'home'), port }), { secrets: new MemorySecretStore() })
  const app = createApp(deps)
  await new Promise<void>((ready) => {
    server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, () => ready())
  })
  deps.worker.start()
  writeServerInfo(deps.env, port)
  base = `http://127.0.0.1:${port}`
  token = mcpToken(deps.env)
})

afterAll(async () => {
  server?.close()
  if (deps) await closeDeps(deps)
  rmSync(root, { recursive: true, force: true })
})

describe('MCP access', () => {
  it('keeps the token and the server address in the app data folder, readable by this user only', () => {
    const tokenFile = join(deps.env.appDataDir, MCP_TOKEN_FILE)
    expect(readFileSync(tokenFile, 'utf8').trim()).toBe(token)
    expect(statSync(tokenFile).mode & 0o077).toBe(0)
    expect(JSON.parse(readFileSync(join(deps.env.appDataDir, SERVER_INFO_FILE), 'utf8'))).toMatchObject({ url: base, pid: process.pid })
  })

  it('refuses requests without the token, from a foreign origin or host, and when turned off', async () => {
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }
    const post = (headers: Record<string, string>) =>
      fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(init) })
    expect((await post({})).status).toBe(401)
    expect((await post({ authorization: 'Bearer nope' })).status).toBe(401)
    expect((await post({ authorization: `Bearer ${token}`, origin: 'https://evil.example' })).status).toBe(403)
    expect((await post({ authorization: `Bearer ${token}` })).status).toBe(200)
    deps.settings.update({ mcp: { enabled: false, sessionCapUsd: 5 } })
    try {
      expect((await post({ authorization: `Bearer ${token}` })).status).toBe(403)
    } finally {
      deps.settings.update({ mcp: { enabled: true, sessionCapUsd: 5 } })
    }
  })

  it('shows the endpoint, token and bridge to the app’s own pages only, and renews the token', async () => {
    expect((await fetch(`${base}/api/integrations/mcp`)).status).toBe(403)
    const info = (await (await fetch(`${base}/api/integrations/mcp`, { headers: { 'x-studio': '1' } })).json()) as McpIntegrationInfo
    expect(info).toMatchObject({ enabled: true, url: `${base}/mcp`, token, appDataDir: deps.env.appDataDir })
    expect(info.bridge.args[0]).toMatch(/studio-mcp\.mjs$/)
    const renewed = (await (await fetch(`${base}/api/integrations/mcp/token`, { method: 'POST', headers: { origin: base, 'x-studio': '1' } })).json()) as McpIntegrationInfo
    expect(renewed.token).not.toBe(token)
    await expect(connect(token)).rejects.toThrow()
    token = renewed.token
  })
})

describe('MCP tools', () => {
  it('lists the tools', async () => {
    const client = await connect()
    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).toEqual(
      expect.arrayContaining(['studio_status', 'list_projects', 'create_project', 'get_project', 'list_assets', 'view_asset', 'list_models', 'generate', 'get_job', 'motion_import', 'add_to_timeline', 'edit_timeline', 'set_story', 'director', 'temp_voice', 'get_motion_import_guide']),
    )
    expect(client.getInstructions()).toMatch(/confirm_usd/)
    await client.close()
  })

  it('builds an explainer: project, motion import, timeline edits, a look at a picture', async () => {
    const client = await connect()
    const project = await call<{ id: string; settings: { fps: number } }>(client, 'create_project', { name: 'MCP explainer', width: 1280, height: 720, fps: 24 })
    expect(project.settings.fps).toBe(24)

    const dir = join(deps.env.tmpDir, 'mcp-fixtures')
    mkdirSync(dir, { recursive: true })
    await runFfmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=320x180:d=0.1', '-frames:v', '1', join(dir, 'red.png')])
    await runFfmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2:sample_rate=48000', '-ac', '1', join(dir, 'tone.wav')])

    const imported = await call<{ assets: Record<string, string>; clips: Record<string, string>; boards: string[] }>(client, 'motion_import', {
      project: 'MCP explainer',
      base_dir: dir,
      import: {
        version: 1,
        media: [
          { key: 'red', path: 'red.png' },
          { key: 'vo', path: 'tone.wav', role: 'dialogue' },
        ],
        boards: [
          {
            name: 'Explainer',
            items: [
              { id: 'f1', kind: 'frame', name: 'Scene 1', x: 0, y: 0, w: 1280, h: 720, fill: '#101820' },
              { id: 'pic', kind: 'asset', assetId: '@@red', x: 700, y: 100, w: 400, h: 225, frameId: 'f1' },
              { id: 'title', kind: 'text', text: 'Hello', fontFamily: 'Inter', fontSize: 72, fontWeight: 700, color: '#ffffff', align: 'left', lineHeight: 1.1, x: 80, y: 200, w: 560, h: 90, frameId: 'f1' },
            ],
          },
        ],
        timeline: [
          { type: 'motion', key: 's1', board: 'Explainer', frame: 'Scene 1', duration: 48, tracks: { title: { opacity: [{ frame: 0, value: 0 }, { frame: 12, value: 1 }] } } },
          { type: 'audio', key: 'voice', media: '@@vo', at: { clip: 's1', offset: 6 } },
        ],
        markers: [{ at: 0, name: 'Intro', kind: 'chapter' }],
      },
    })
    expect(Object.keys(imported.assets)).toEqual(['red', 'vo'])

    // A picture already in the project goes on the timeline by id.
    const added = await call<{ clips: Record<string, string> }>(client, 'add_to_timeline', { project: project.id, clips: [{ asset: imported.assets.red, key: 'still', duration: 24 }] })
    const stillId = added.clips.still!

    type Summary = { durationFrames: number; boards: Array<{ name: string; frames: Array<{ name: string }> }>; timeline: { storyline: Array<{ id: string; kind: string }>; connected: Array<{ kind: string; lane: number }>; markers: Array<{ name: string }> } }
    let state = await call<Summary>(client, 'get_project', { project: project.id })
    expect(state.boards[0]).toMatchObject({ name: 'Explainer', frames: [{ name: 'Scene 1' }] })
    expect(state.timeline.storyline.map((c) => c.kind)).toEqual(['motion', 'media'])
    expect(state.timeline.connected).toEqual([expect.objectContaining({ kind: 'media', lane: -1 })])
    expect(state.timeline.markers.map((m) => m.name)).toEqual(['Intro'])
    expect(state.durationFrames).toBe(72)

    await call(client, 'edit_timeline', { project: project.id, ops: [{ op: 'trim', id: stillId, edge: 'end', delta: -12 }, { op: 'marker', frame: 48, name: 'Still' }] })
    state = await call<Summary>(client, 'get_project', { project: project.id })
    expect(state.durationFrames).toBe(60)
    expect(state.timeline.markers.map((m) => m.name)).toEqual(['Intro', 'Still'])
    const bad = await client.callTool({ name: 'edit_timeline', arguments: { project: project.id, ops: [{ op: 'remove', ids: ['nope'] }] } })
    expect(bad.isError).toBe(true)
    expect((bad.content as ToolContent)[0]!.text).toMatch(/nothing on the timeline has the id nope/)

    const view = await client.callTool({ name: 'view_asset', arguments: { asset: imported.assets.red } })
    const image = (view.content as ToolContent).find((c) => c.type === 'image')
    expect(image?.mimeType).toBe('image/jpeg')
    expect(Buffer.from(image!.data!, 'base64').subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
    await client.close()
  })

  it('runs a free demo render at once and shows the result', async () => {
    const client = await connect()
    const project = await call<{ id: string }>(client, 'create_project', { name: 'MCP demo render' })
    const started = await call<{ started: boolean; chargedUsd: number; jobs: Array<{ id: string }> }>(client, 'generate', { project: project.id, model: 'mock-image', params: { prompt: 'A red kite over the sea' } })
    expect(started).toMatchObject({ started: true, chargedUsd: 0 })
    const res = await client.callTool({ name: 'get_job', arguments: { job: started.jobs[0]!.id, wait_seconds: 60 } })
    const content = res.content as ToolContent
    expect(JSON.parse(content[0]!.text!)).toMatchObject({ status: 'succeeded', outputAssetIds: [expect.any(String)] })
    expect(content.some((c) => c.type === 'image')).toBe(true)
    await client.close()
  })

  it('starts nothing paid without the user’s agreed price, and never over the session cap', async () => {
    const client = await connect()
    const project = await call<{ id: string }>(client, 'create_project', { name: 'MCP paid' })
    const params = { prompt: 'A lighthouse at dusk' }
    const asked = await call<{ started: boolean; reason: string; estimateUsd: number }>(client, 'generate', { project: project.id, model: 'fal-flux-2-pro', params })
    expect(asked).toMatchObject({ started: false, reason: 'needs_confirmation' })
    expect(asked.estimateUsd).toBeGreaterThan(0)
    const tooLittle = await call<{ reason: string }>(client, 'generate', { project: project.id, model: 'fal-flux-2-pro', params, confirm_usd: asked.estimateUsd / 2 })
    expect(tooLittle.reason).toBe('needs_confirmation')
    deps.settings.update({ mcp: { enabled: true, sessionCapUsd: asked.estimateUsd / 2 } })
    try {
      const capped = await call<{ reason: string }>(client, 'generate', { project: project.id, model: 'fal-flux-2-pro', params, confirm_usd: asked.estimateUsd })
      expect(capped.reason).toBe('over_cap')
    } finally {
      deps.settings.update({ mcp: { enabled: true, sessionCapUsd: 5 } })
    }
    // Confirmed and under the cap it goes to the provider, which says the key is missing: still nothing queued.
    const res = await client.callTool({ name: 'generate', arguments: { project: project.id, model: 'fal-flux-2-pro', params, confirm_usd: asked.estimateUsd } })
    expect(res.isError).toBe(true)
    expect((res.content as ToolContent)[0]!.text).toMatch(/not configured/)
    expect(await call<unknown[]>(client, 'list_jobs', { project: project.id })).toEqual([])
    await client.close()
  })
})

describe('cost guard', () => {
  it('lets free renders through and needs a confirmed price for paid ones', () => {
    expect(checkSpend({ free: true, estimateUsd: null, spentUsd: 99, capUsd: 0 })).toEqual({ run: true, chargeUsd: 0 })
    expect(checkSpend({ free: false, estimateUsd: 0.4, spentUsd: 0, capUsd: 5 })).toMatchObject({ run: false, reason: 'needs_confirmation' })
    expect(checkSpend({ free: false, estimateUsd: 0.4, confirmUsd: 0.39, spentUsd: 0, capUsd: 5 })).toMatchObject({ run: false, reason: 'needs_confirmation' })
    expect(checkSpend({ free: false, estimateUsd: 0.4, confirmUsd: 0.4, spentUsd: 0, capUsd: 5 })).toEqual({ run: true, chargeUsd: 0.4 })
    expect(checkSpend({ free: false, estimateUsd: 0.4, confirmUsd: 1, spentUsd: 4.8, capUsd: 5 })).toMatchObject({ run: false, reason: 'over_cap' })
    // An unknown price is charged at what the user agreed to.
    expect(checkSpend({ free: false, estimateUsd: null, spentUsd: 0, capUsd: 5 })).toMatchObject({ run: false, reason: 'needs_confirmation' })
    expect(checkSpend({ free: false, estimateUsd: null, confirmUsd: 2, spentUsd: 0, capUsd: 5 })).toEqual({ run: true, chargeUsd: 2 })
  })
})

describe('requests to the app window', () => {
  it('goes to the first window that claims it, and fails when none does', async () => {
    const requests = new AppRequests(deps.events)
    const seen: string[] = []
    const stop = deps.events.subscribe((e) => {
      if (e.type !== 'app.request') return
      seen.push(e.action)
      // Two windows race: only the first gets it.
      expect(requests.claim(e.requestId)).toBe(true)
      expect(requests.claim(e.requestId)).toBe(false)
      setTimeout(() => requests.done(e.requestId, { ok: true, result: { assetId: 'a1' } }), 10)
    })
    try {
      await expect(requests.ask('export', 'p1', {}, { claimMs: 200, doneMs: 1000 })).resolves.toEqual({ assetId: 'a1' })
    } finally {
      stop()
    }
    expect(seen).toEqual(['export'])
    await expect(requests.ask('open-project', 'p1', {}, { claimMs: 20, doneMs: 1000 })).rejects.toBeInstanceOf(NotClaimedError)
  })
})

describe('stdio bridge', () => {
  type Answer = { id: number | null; result?: { tools?: Array<{ name: string }> }; error?: { message: string } }
  const initParams = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bridge-test', version: '1' } }

  function startBridge(env: Record<string, string>) {
    const child = spawn(process.execPath, [resolve('scripts/studio-mcp.mjs')], { env: { ...process.env, STUDIO_APP_DATA: deps.env.appDataDir, ...env }, stdio: ['pipe', 'pipe', 'inherit'] })
    const lines = createInterface({ input: child.stdout! })
    const seen: Answer[] = []
    const answers = new Map<number, (m: Answer) => void>()
    lines.on('line', (line) => {
      const m = JSON.parse(line) as Answer
      seen.push(m)
      if (m.id !== null) answers.get(m.id)?.(m)
    })
    const send = (m: Record<string, unknown>) => child.stdin!.write(`${JSON.stringify(m)}\n`)
    const request = (id: number, method: string, params: unknown = {}) =>
      new Promise<Answer>((done) => {
        answers.set(id, done)
        send({ jsonrpc: '2.0', id, method, params })
      })
    const stop = async () => {
      child.stdin!.end()
      await new Promise((done) => child.once('exit', done))
    }
    return { send, request, stop, seen }
  }

  it('finds the server from its app data folder and relays requests', async () => {
    const bridge = startBridge({})
    const init = await bridge.request(1, 'initialize', initParams)
    expect(init.result).toBeDefined()
    bridge.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    const list = await bridge.request(2, 'tools/list')
    expect(list.result?.tools?.map((t) => t.name)).toContain('motion_import')
    await bridge.stop()
  })

  it('answers the request itself when the app refuses it (wrong token)', async () => {
    const bridge = startBridge({ STUDIO_MCP_TOKEN: 'not-the-token' })
    const init = await bridge.request(1, 'initialize', initParams)
    expect(init.error?.message).toMatch(/token/)
    // The app's own id-less refusal is not passed on.
    expect(bridge.seen.every((m) => m.id === 1)).toBe(true)
    await bridge.stop()
  })
})
