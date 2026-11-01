import { z } from 'zod'
import { type AssetPlan, type AssetSetRequest, type AssetSetResponse, DELIVERABLES, TEXT_AREAS, type TextArea, deliverable } from '../../shared/types/assetSet'
import { ApiError } from '../http'
import { type DirectorCredentials, structuredCall } from './director'

// Plain field types only (structured outputs support a JSON-schema subset); counts and lengths are enforced after.
const planSchema = z.object({
  title: z.string(),
  style: z.string(),
  items: z.array(
    z.object({
      deliverable: z.string(),
      title: z.string(),
      prompt: z.string(),
      headline: z.string(),
      subline: z.string(),
      textArea: z.string(),
    }),
  ),
})

const PLAN_SHAPE = `{"title": string, "style": string, "items": [{"deliverable": string, "title": string, "prompt": string, "headline": string, "subline": string, "textArea": string}]}`

const SYSTEM = `You are a brand designer and art director. From a short brief you plan a cohesive set of images for a brand, website or campaign; an AI image model then generates each one.

- "style": one sentence describing the shared look of the whole set (medium, palette, lighting, texture, mood). It is appended to every prompt, so do not repeat it inside the prompts.
- Plan exactly the requested number of items for each requested deliverable, using the deliverable ids given. Make the items of one deliverable genuinely different from each other (different concepts, compositions or subjects), not variations of one idea.
- "prompt" is for the image model: the subject and what happens, composition and framing for that format, where to leave calm empty space for text, lighting and colours. Concrete and visual, one paragraph, under 80 words.
- Never ask for text, letters, words or UI inside an image, except logos: a logo may be a wordmark or lettermark of the brand name, spelled exactly. Logos: simple, flat, centred on a plain white background, no mockups.
- Icons: one consistent set — same stroke, perspective, colours and background for every icon; each prompt names one concept.
- "headline" and "subline" are the copy placed over the image as live text for deliverables that take copy (hero, link preview, social posts, stories, ads, thumbnails): headline at most 7 words, subline at most 14 words, in the brand's voice and in the language of the brief. Leave both empty for logos, icons and backgrounds.
- "textArea" says where the prompt leaves that calm space for the copy: "top", "bottom", "left", "right" or "center" ("left" when there is no copy).
- "title" is a 2–5 word name for the item, shown on the canvas.
- Respect the brand's colours, style and things to avoid when given.`

function userPrompt(req: AssetSetRequest): string {
  const parts = [`Brief:\n"""\n${req.brief.trim()}\n"""`]
  const b = req.brand
  if (b) {
    const lines = [
      b.name && `Brand name: ${b.name}`,
      b.description && `About: ${b.description}`,
      b.style && `Visual style: ${b.style}`,
      b.colors?.length && `Colours: ${b.colors.join(', ')}`,
      b.avoid && `Avoid: ${b.avoid}`,
      b.tone && `Voice: ${b.tone}`,
    ].filter(Boolean)
    if (lines.length) parts.push(`Brand kit:\n${lines.join('\n')}`)
  }
  const wanted = req.deliverables
    .map((d) => ({ d: deliverable(d.id), count: d.count }))
    .filter((x) => x.d && x.count > 0)
    .map((x) => `- ${x.d!.id} × ${x.count} (${x.d!.label}; ${x.d!.copy ? 'takes a headline and subline' : 'no copy'})`)
  parts.push(`Deliverables:\n${wanted.join('\n')}`)
  if (req.language && !/^en/i.test(req.language)) parts.push(`Write the headlines and sublines in ${req.language}; keep the prompts in English.`)
  return parts.join('\n\n')
}

const textAreaOf = (v: string | undefined): TextArea => {
  const t = (v ?? '').trim().toLowerCase()
  return (TEXT_AREAS as readonly string[]).includes(t) ? (t as TextArea) : 'left'
}

/** Keeps requested deliverables only, at most the requested count each, with trimmed text and no copy where none fits. */
export function sanitizePlan(plan: Omit<AssetPlan, 'items'> & { items: (Omit<AssetPlan['items'][number], 'textArea'> & { textArea?: string })[] }, req: AssetSetRequest): AssetPlan {
  const want = new Map(req.deliverables.map((d) => [d.id, Math.max(0, Math.min(deliverable(d.id)?.maxCount ?? 0, Math.round(d.count)))]))
  const used = new Map<string, number>()
  const items = plan.items
    .filter((i) => {
      const left = (want.get(i.deliverable) ?? 0) - (used.get(i.deliverable) ?? 0)
      if (left <= 0 || !i.prompt.trim()) return false
      used.set(i.deliverable, (used.get(i.deliverable) ?? 0) + 1)
      return true
    })
    .map((i) => {
      const copy = deliverable(i.deliverable)?.copy ?? false
      return {
        deliverable: i.deliverable,
        title: i.title.trim().slice(0, 60) || deliverable(i.deliverable)!.label,
        prompt: i.prompt.trim().slice(0, 1200),
        headline: copy ? i.headline.trim().slice(0, 80) : '',
        subline: copy ? i.subline.trim().slice(0, 140) : '',
        textArea: textAreaOf(i.textArea),
      }
    })
  if (!items.length) throw new ApiError(502, 'The planner returned no usable items — try again or adjust the brief')
  return { title: plan.title.trim().slice(0, 60) || 'Asset set', style: plan.style.trim().slice(0, 400), items }
}

/** Offline plan for demo mode: one templated item per requested slot. */
export function demoPlan(req: AssetSetRequest): AssetPlan {
  const subject = req.brand?.name || req.brief.trim().split(/[.\n]/)[0]!.slice(0, 60) || 'the brand'
  const items = req.deliverables.flatMap(({ id, count }) => {
    const d = deliverable(id)
    if (!d) return []
    return Array.from({ length: Math.min(count, d.maxCount) }, (_, n) => ({
      deliverable: id,
      title: `${d.label} ${n + 1}`,
      prompt:
        id === 'logo'
          ? `Simple flat logo mark for ${subject}, centred on a plain white background, concept ${n + 1}`
          : `${d.label} image for ${subject}, clean composition with calm empty space on one side, variation ${n + 1}`,
      headline: d.copy ? `${subject}` : '',
      subline: d.copy ? 'Made with care, made for you' : '',
      textArea: 'left' as const,
    }))
  })
  return { title: `${subject} — asset set`, style: req.brand?.style || 'clean, modern, consistent palette, soft natural light', items }
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined)

/** The request as the planner may use it: known deliverables once each, counts within limits, text capped. */
export function cleanRequest(req: AssetSetRequest): AssetSetRequest {
  const seen = new Set<string>()
  const deliverables = (Array.isArray(req.deliverables) ? req.deliverables : []).flatMap((d) => {
    const def = d && typeof d.id === 'string' ? deliverable(d.id) : undefined
    const count = Math.min(def?.maxCount ?? 0, Math.max(0, Math.round(Number(d?.count) || 0)))
    if (!def || !count || seen.has(def.id)) return []
    seen.add(def.id)
    return [{ id: def.id, count }]
  })
  const b = req.brand && typeof req.brand === 'object' ? req.brand : undefined
  return {
    brief: str(req.brief, 4000) ?? '',
    deliverables,
    language: str(req.language, 40),
    brand: b && {
      name: str(b.name, 120),
      description: str(b.description, 1000),
      style: str(b.style, 600),
      avoid: str(b.avoid, 400),
      tone: str(b.tone, 300),
      colors: Array.isArray(b.colors) ? b.colors.filter((x): x is string => typeof x === 'string').slice(0, 12).map((x) => x.slice(0, 40)) : undefined,
    },
  }
}

export async function planAssetSet(raw: AssetSetRequest, creds: DirectorCredentials, demoMode: boolean): Promise<AssetSetResponse> {
  const clean = cleanRequest(raw)
  if (!clean.brief) throw new ApiError(400, 'Write a short brief first')
  if (!clean.deliverables.length) throw new ApiError(400, `Pick at least one deliverable (${DELIVERABLES.map((d) => d.id).join(', ')})`)
  if (creds.anthropic || creds.openrouter || creds.fal) {
    const { result, via, model } = await structuredCall(creds, SYSTEM, userPrompt(clean), planSchema, PLAN_SHAPE, 'medium')
    return { plan: sanitizePlan(result, clean), via, model }
  }
  if (demoMode) return { plan: sanitizePlan(demoPlan(clean), clean), via: 'demo', model: 'templates' }
  throw new ApiError(400, 'Planning assets needs an Anthropic, OpenRouter or fal.ai key (Settings → Providers)')
}
