#!/usr/bin/env node
/**
 * Imports a motion-import JSON file (docs/motion-import.md) into a project of the running app:
 *
 *   pnpm wildroom:import explainer.json --project "Drama Triangle"
 *   pnpm wildroom:import explainer.json --create "New explainer"
 *
 * Relative media and font paths are read from the JSON file's folder. The project can also be named in the file
 * ("project": "<id or name>"). The app (or `pnpm dev`) must be running; --server (or STUDIO_SERVER) points at it when
 * it isn't on http://127.0.0.1:7777. An editor that has the project open reloads it by itself.
 */
import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(`--${name}`)
  if (i < 0) return undefined
  const value = args[i + 1]
  args.splice(i, 2)
  return value
}
const server = (flag('server') ?? process.env.STUDIO_SERVER ?? 'http://127.0.0.1:7777').replace(/\/$/, '')
const projectArg = flag('project')
const create = flag('create')
const file = args[0]
if (!file || args.length > 1) {
  console.error('Usage: pnpm wildroom:import <file.json> [--project <id or name> | --create <name>] [--server <url>]')
  process.exit(2)
}

const path = resolve(file)
let body
try {
  body = JSON.parse(readFileSync(path, 'utf8'))
} catch (err) {
  console.error(`Can't read ${path}: ${err.message}`)
  process.exit(1)
}
const base = dirname(path)
for (const list of [body.media, body.fonts]) for (const m of list ?? []) if (m && typeof m.path === 'string' && !isAbsolute(m.path)) m.path = resolve(base, m.path)
const named = projectArg ?? body.project
delete body.project

/** The app checks where a request comes from: it is sent as the app itself. */
async function api(method, url, payload) {
  let res
  try {
    res = await fetch(`${server}${url}`, {
      method,
      headers: { origin: server, 'x-studio': '1', ...(payload ? { 'content-type': 'application/json' } : {}) },
      body: payload ? JSON.stringify(payload) : undefined,
    })
  } catch {
    console.error(`The app doesn't answer at ${server}. Start it (or pnpm dev), or pass --server.`)
    process.exit(1)
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    console.error(`${method} ${url}: ${data.error ?? res.statusText}`)
    for (const issue of data.details?.issues ?? []) console.error(`  · ${issue}`)
    process.exit(1)
  }
  return data
}

let projectId
if (create) {
  projectId = (await api('POST', '/api/projects', { name: create })).id
  console.log(`Created “${create}”`)
} else if (named) {
  const list = await api('GET', '/api/projects')
  const entries = Array.isArray(list) ? list : (list.projects ?? [])
  const hits = entries.filter((p) => p.id === named || p.name === named)
  if (hits.length !== 1) {
    console.error(hits.length ? `More than one project is called “${named}”: use its id.` : `No project “${named}”. Projects: ${entries.map((p) => p.name).join(', ')}`)
    process.exit(1)
  }
  projectId = hits[0].id
  if (!projectId) {
    console.error(`“${named}” hasn't been opened in the app yet: open it once, then import.`)
    process.exit(1)
  }
} else {
  console.error('Which project? Pass --project <id or name>, --create <name>, or put "project" in the file.')
  process.exit(1)
}

const out = await api('POST', `/api/projects/${projectId}/motion-import`, body)
console.log(`Imported into ${projectId} (revision ${out.revision})`)
console.log(`  media: ${Object.keys(out.assets).length} · fonts: ${Object.keys(out.fonts).length} · boards: ${out.boards.length} · clips: ${Object.keys(out.clips).length}`)
for (const w of out.warnings) console.log(`  ! ${w}`)
// Done with the project: the app unmounts it unless an editor has it open (or a job is still using it).
await fetch(`${server}/api/projects/${projectId}/close`, { method: 'POST', headers: { origin: server, 'x-studio': '1', 'content-type': 'application/json' }, body: '{}' }).catch(() => {})
