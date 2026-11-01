import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { z } from 'zod'
import { ENHANCE_MAX_REFERENCES } from '../../shared/prompt/enhanceRefs'
import { frameJpeg } from '../services/analysis'
import { ENHANCE_KINDS, type TrimDialogueRequest } from '../../shared/types/api'
import type { BreakdownRequest, ImproveLookRequest, OutlineRequest, PlaceViewRequest, SceneShotsRequest, WriteScriptRequest } from '../../shared/types/story'
import type { AppDeps } from '../app'
import { badRequest, readJson } from '../http'
import { directorPlanRequestSchema } from '../../shared/director/plan'
import type { AssetSetRequest } from '../../shared/types/assetSet'
import { planAssetSet } from '../services/assetSet'
import { planExplainer } from '../services/explainer'
import type { ExplainerRequest } from '../../shared/motion/explainer'
import { breakdownScript, enhancePrompt, improveLook, outlineScript, planDirector, trimDialogue, writePlaceView, writeSceneShots, writeScript } from '../services/director'
import { type LlmCredentials, listTextModels, resolveTarget } from '../services/llm'

/** Keys that can run text models, plus the model chosen in Settings → Director. */
export function directorCredentials(deps: AppDeps): LlmCredentials {
  return {
    anthropic: deps.secrets.get('anthropic', 'apiKey'),
    openrouter: deps.secrets.get('openrouter', 'apiKey'),
    fal: deps.secrets.get('fal', 'apiKey'),
    choice: deps.settings.get().textModel,
  }
}

const enhanceRequestSchema = z.object({
  prompt: z.string().min(1),
  kind: z.enum(ENHANCE_KINDS),
  style: z.string().optional(),
  model: z.string().optional(),
  references: z
    .array(z.object({ assetId: z.string().min(1), role: z.enum(['start', 'end', 'reference', 'input']), token: z.string().min(1).max(80) }))
    .optional(),
})

export function directorRoutes(deps: AppDeps) {
  /** Scratch space for the JPEGs the Director reads. */
  const workDir = () => {
    const dir = join(deps.env.tmpDir, 'director')
    mkdirSync(dir, { recursive: true })
    return dir
  }
  const r = new Hono()
  const creds = () => directorCredentials(deps)

  /** Which route and model the Director uses now (none / demo when no key can run it). */
  r.get('/director/status', async (c) => {
    const keys = creds()
    try {
      const target = await resolveTarget(keys)
      return c.json({ via: target.via, model: target.model })
    } catch (err) {
      // A key is set but can't run the chosen route/model: say why, so it isn't mistaken for a missing key.
      const reason = keys.anthropic || keys.openrouter || keys.fal ? (err instanceof Error ? err.message : String(err)) : undefined
      return c.json({ via: deps.settings.get().demoMode ? 'demo' : 'none', model: keys.choice?.model ?? deps.settings.get().textModel.model, reason })
    }
  })

  /** Text models the Director can use (OpenRouter's catalogue; fal.ai routes the same ids). */
  r.get('/director/models', async (c) => c.json(await listTextModels()))

  r.post('/director/breakdown', async (c) => {
    const body = await readJson<BreakdownRequest>(c)
    return c.json(await breakdownScript(body, creds(), deps.settings.get().demoMode))
  })

  /** Pass one of the scene-by-scene flow: cast, places, chapters and scenes — no shots yet. */
  r.post('/director/outline', async (c) => {
    const body = await readJson<OutlineRequest>(c)
    return c.json(await outlineScript(body, creds(), deps.settings.get().demoMode))
  })

  /** The look designer's "Improve with AI": a hero's or a place's description. */
  r.post('/director/improve-look', async (c) => {
    const body = await readJson<ImproveLookRequest>(c)
    return c.json(await improveLook(body, creds(), deps.settings.get().demoMode))
  })

  /** One of a place's other directions written out, before the look designer draws it. */
  r.post('/director/place-view', async (c) => {
    const body = await readJson<PlaceViewRequest>(c)
    return c.json(await writePlaceView(body, creds(), deps.settings.get().demoMode))
  })

  /** An idea → a short screenplay, into the Story step's script box. */
  r.post('/director/write-script', async (c) => {
    const body = await readJson<WriteScriptRequest>(c)
    return c.json(await writeScript(body, creds(), deps.settings.get().demoMode))
  })

  /** Pass two: the shots of one scene. */
  r.post('/director/scene-shots', async (c) => {
    const body = await readJson<SceneShotsRequest>(c)
    return c.json(await writeSceneShots(body, creds(), deps.settings.get().demoMode))
  })

  /** Brief → a planned set of brand / web / social images (the canvas generates them). */
  r.post('/director/asset-set', async (c) => {
    const body = await readJson<AssetSetRequest>(c)
    return c.json(await planAssetSet(body, creds(), deps.settings.get().demoMode))
  })

  /**
   * The Director's chat: a message, the last turns and the project in brief → a reply and a plan of steps the app
   * runs once the user approves them (it prices them first). Plans only: nothing is generated here.
   */
  r.post('/director/plan', async (c) => {
    const parsed = directorPlanRequestSchema.safeParse(await readJson<unknown>(c))
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      throw badRequest(issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'Invalid request')
    }
    return c.json(await planDirector(parsed.data, creds(), deps.settings.get().demoMode))
  })

  /** An approved explainer step's scenes: voice-over, elements and animations, validated (nothing is made here). */
  r.post('/director/explainer', async (c) => {
    const body = await readJson<ExplainerRequest>(c)
    return c.json(await planExplainer(body, creds(), deps.settings.get().demoMode))
  })

  r.post('/director/enhance', async (c) => {
    const parsed = enhanceRequestSchema.safeParse(await readJson<unknown>(c))
    if (!parsed.success) throw badRequest('Invalid request')
    // The pictures that go with the prompt, as small JPEGs: images of one project that still exist; the rest are left out.
    const refs = (parsed.data.references ?? []).slice(0, ENHANCE_MAX_REFERENCES)
    const rows = refs.map((ref) => ({ ref, row: deps.media.get(ref.assetId) }))
    const projectId = rows.find((x) => x.row && !x.row.deletedAt)?.row?.projectId
    const usable = rows.filter((x) => x.row && !x.row.deletedAt && x.row.kind === 'image' && x.row.projectId === projectId)
    const pictures = await Promise.all(usable.map(async ({ ref, row }) => ({ ref, jpeg: await frameJpeg(deps.media.originalPath(row!), 0, workDir(), 768) })))
    return c.json(await enhancePrompt(parsed.data, creds(), pictures))
  })

  /** "Shorten lines": the same lines, tightened to be speakable within the shot (dialogue-length check). */
  r.post('/director/trim-dialogue', async (c) => {
    const body = await readJson<TrimDialogueRequest>(c)
    return c.json(await trimDialogue(body, creds(), deps.settings.get().demoMode))
  })

  return r
}
