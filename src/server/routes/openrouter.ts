import { Hono } from 'hono'
import { badRequest } from '../http'
import { imageModelPricing, listImageModels } from '../providers/openrouter'

/** OpenRouter's image models for the "Any OpenRouter image model" picker: the list, and one model's price. */
export function openRouterRoutes() {
  const r = new Hono()

  r.get('/openrouter/image-models', async (c) => c.json(await listImageModels()))

  r.get('/openrouter/image-models/pricing', async (c) => {
    const model = c.req.query('model')
    if (!model) throw badRequest('Missing model')
    return c.json({ model, lines: await imageModelPricing(model) })
  })

  return r
}
