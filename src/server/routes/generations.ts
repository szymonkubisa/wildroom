import { Hono } from 'hono'
import { parseParams } from '../../shared/models/params'
import { getModel } from '../../shared/models/registry'
import type { CreateGenerationRequest, ProjectSpendDTO } from '../../shared/types/api'
import type { AppDeps } from '../app'
import { badRequest, readJson } from '../http'
import { gpuSessionsTotal, summarizeSpend } from '../services/spend'

export function generationRoutes(deps: AppDeps) {
  const { worker } = deps
  const r = new Hono()

  r.post('/generations', async (c) => {
    const body = await readJson<CreateGenerationRequest>(c)
    if (!body.projectId || !body.modelId) throw badRequest('projectId and modelId are required')
    return c.json(worker.create(body), 201)
  })

  r.post('/generations/estimate', async (c) => {
    const body = await readJson<{ modelId: string; params: Record<string, unknown>; variants?: number }>(c)
    const model = getModel(body.modelId)
    if (!model) throw badRequest('Unknown model')
    const parsed = parseParams(model, body.params ?? {})
    const estimate = model.estimateCost(parsed.ok ? parsed.values : { ...body.params })
    const variants = Math.max(1, body.variants ?? 1)
    return c.json({ ...estimate, usd: estimate.usd == null ? null : estimate.usd * variants })
  })

  r.get('/projects/:projectId/generations', (c) => {
    const store = deps.registry.require(c.req.param('projectId'))
    return c.json(worker.list(store.id, { activeOnly: c.req.query('active') === '1' }))
  })

  /** Budget overview: every generation record of the project (the list above stops at 300), plus machine-wide GPU time. */
  r.get('/projects/:projectId/spend', (c) => {
    const store = deps.registry.require(c.req.param('projectId'))
    const spend: ProjectSpendDTO = summarizeSpend(store.generations.values())
    const gpu = gpuSessionsTotal(deps.runpodState.sessions, deps.gpuSession.dto().costUsd)
    return c.json(gpu === undefined ? spend : { ...spend, gpuSessionsUsd: gpu })
  })

  // Every project's queued and running jobs: the queue is shared, so positions and start times depend on all of them.
  r.get('/generations/active', (c) => c.json(worker.activeAll()))
  // Lately finished jobs of every project, also of projects closed since: the shared queue panel's history.
  r.get('/generations/recent', (c) => c.json(worker.recent()))
  r.get('/generations/:id', (c) => c.json(worker.get(c.req.param('id'))))
  /** What was asked for, sent to the provider and answered (Assets → right-click → What was sent). */
  r.get('/generations/:id/details', (c) => c.json(worker.details(c.req.param('id'))))
  r.post('/generations/:id/cancel', async (c) => c.json(await worker.cancel(c.req.param('id'))))
  r.post('/generations/:id/retry', (c) => c.json(worker.retry(c.req.param('id')), 201))
  r.post('/generations/:id/move', async (c) => {
    const { to } = await readJson<{ to: 'top' | 'up' | 'down' | 'bottom' }>(c)
    if (!['top', 'up', 'down', 'bottom'].includes(to)) throw badRequest('to must be top, up, down or bottom')
    return c.json(worker.move(c.req.param('id'), to))
  })

  return r
}
