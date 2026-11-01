import {
  EXPLAINER_ANIMATIONS,
  EXPLAINER_ELEMENTS_MAX,
  EXPLAINER_IMAGES_MAX,
  EXPLAINER_LAYOUTS,
  EXPLAINER_SCENES_MAX,
  EXPLAINER_STYLES,
  type ExplainerRequest,
  type ExplainerResponse,
  type RawExplainer,
  explainerEstimate,
  explainerStyle,
  rawExplainerSchema,
  sanitizeExplainer,
} from '../../shared/motion/explainer'
import { ApiError } from '../http'
import { type DirectorCredentials, structuredCall } from './director'

const SHAPE = `{"title": string, "style": string, "scenes": [{"title": string, "voiceover": string, "zoom": boolean, "layout": string, "elements": [{"kind": string, "text": string, "prompt": string, "shape": string, "cue": string, "animation": string, "key": string}]}]}`

export function explainerSystem(): string {
  return `You write animated explainer videos: motion graphics where a narrator speaks and, on each scene, a few elements come in as their words are said. The app lays the elements out on a frame in the scene's layout, draws the pictures with an image model, records the voice-over and times the animations to it.

- "scenes": ${EXPLAINER_SCENES_MAX} at most, each one idea. "voiceover": what the narrator says in that scene — one to three short spoken sentences, about 2.5 words a second, in the language the user wrote in. "title": a few words naming the scene.
- "layout": one of ${EXPLAINER_LAYOUTS.map((l) => `"${l}"`).join(', ')}:
  "column" words on the left, pictures on the right (the default); "split" one picture filling the left half, words on the right; "center" a big centred headline (and a row of pictures under it) — openings, statements, quotes; "full-bleed" one picture filling the frame with the words over its lower part — a mood or a place; "cards" up to three cards side by side, each a picture with a short line under it — comparisons, steps, options; "diagram" two to four short points (text or number elements) round a ring, joined by lines that draw themselves — cycles, triangles, relationships. Vary the layouts through the video.
- "elements": 2 to ${EXPLAINER_ELEMENTS_MAX} per scene, in reading order:
  - "kind": "title" (the scene's headline, a few words), "text" (a short line, a key fact or a step — never the voice-over itself), "number" (a figure that counts up as it appears: "1970", "73%", "3×"), "shape" (an accent: "shape" "rect" is a bar under the line before it, "ellipse" a dot), "line" (a wave drawn across, a flourish) or "image" (up to ${EXPLAINER_IMAGES_MAX} per scene).
  - "text": the words on screen for titles, text and numbers ("" otherwise). Short: titles under 6 words, text under 12. Light markup is allowed: *italic*, **bold**, ==highlighted==, {#hex|coloured}.
  - "prompt": for images only, what the image model draws — concrete and visual, one clear subject, under 50 words, no words or letters in the picture ("" otherwise).
  - "cue": one to three words of that scene's voice-over, exactly as spoken, when the element should appear ("" = right after the element before it). Cue pictures and key lines to the words that introduce them.
  - "animation": "" lets the style choose (best in most cases), or one of ${EXPLAINER_ANIMATIONS.map((a) => `"${a}"`).join(', ')}. Word moves (typewriter, words, words-rise, words-pop, words-blur, letters-rise, highlight) are for titles and text; "count-up" for numbers; "draw" for shapes and lines.
  - "key": "" normally. Give an element a short key (e.g. "triangle", "hero") to keep it on screen across the next scenes: a later element with the same key and kind stays where it was, with the same picture, instead of coming in again — for a character or a diagram that lasts through the cuts.
- "zoom": true for a scene whose picture the narrator dwells on (the camera pushes in on it).
- "style": one sentence on the pictures' shared look (medium, palette, lighting), added to every image prompt. Leave it short when the user picked a look: the look sets it.
- "title": the explainer's name.`
}

export function explainerUserPrompt(req: ExplainerRequest): string {
  const est = explainerEstimate(req.seconds)
  const brand = req.brand
  const look = req.style && req.style !== 'default' ? EXPLAINER_STYLES[req.style] : undefined
  return [
    `Length: about ${Math.round(req.seconds)} seconds — about ${est.scenes} scenes.`,
    look ? `Look: “${look.label}” — ${look.description}. Write for it (its pictures: ${look.imageStyle}).` : '',
    brand?.name ? `Brand: ${brand.name}.` : '',
    brand?.style ? `Brand style: ${brand.style}.` : '',
    brand?.colors?.length ? `Brand colours: ${brand.colors.join(', ')}.` : '',
    `What the explainer is about (or the script to follow):\n${req.topic}`,
  ]
    .filter(Boolean)
    .join('\n')
}

/** The layouts demo scenes take in turn (every one shown in a few scenes). */
const DEMO_LAYOUTS = ['center', 'column', 'diagram', 'cards', 'split', 'full-bleed'] as const

/**
 * Without a text model (demo mode): a scene per sentence, in each layout in turn — a title and an accent, a key line
 * (or a number when the sentence has one), the pictures the layout wants; the first picture stays for the next scene.
 */
export function demoExplainer(req: ExplainerRequest): RawExplainer {
  const sentences = req.topic
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.split(/\s+/).length >= 3)
  const scenes = (sentences.length ? sentences : [req.topic.trim() || 'An idea worth explaining.']).slice(0, explainerEstimate(req.seconds).scenes)
  const el = (o: Partial<RawExplainer['scenes'][number]['elements'][number]>) => ({ kind: 'text', text: '', prompt: '', shape: 'rect', cue: '', animation: '', key: '', ...o })
  return {
    title: scenes[0]!.split(/\s+/).slice(0, 5).join(' '),
    style: 'flat vector illustration, soft gradients, friendly',
    scenes: scenes.map((voiceover, i) => {
      const words = voiceover.replace(/[.!?]+$/, '').split(/\s+/)
      const layout = DEMO_LAYOUTS[i % DEMO_LAYOUTS.length]!
      const number = /\d/.test(voiceover) ? voiceover.match(/\d[\d.,%]*/)![0] : undefined
      const line = el(number ? { kind: 'number', text: number, cue: words[4] ?? '' } : { kind: 'text', text: words.slice(4, 14).join(' '), cue: words[4] ?? '' })
      const title = el({ kind: 'title', text: words.slice(0, 4).join(' ') })
      const picture = (k: number) => el({ kind: 'image', prompt: `${voiceover} (${k + 1})`, cue: words.at(-1) ?? '' })
      const elements =
        layout === 'diagram'
          ? [title, el({ kind: 'text', text: words[0] ?? 'One' }), el({ kind: 'text', text: words[1] ?? 'Two', cue: words[1] ?? '' }), el({ kind: 'text', text: words[2] ?? 'Three', cue: words[2] ?? '' })]
          : layout === 'cards'
            ? [title, picture(0), el({ kind: 'text', text: words.slice(0, 3).join(' ') }), picture(1), el({ kind: 'text', text: words.slice(3, 6).join(' ') })]
            : [title, el({ kind: layout === 'center' ? 'line' : 'shape' }), line, { ...picture(0), key: i === 0 ? 'hero' : '' }]
      return { title: words.slice(0, 4).join(' '), voiceover, zoom: layout === 'column', layout, elements }
    }),
  }
}

/** The explainer's scenes written by the Director's text model (or the demo rules), validated. Nothing is made here. */
export async function planExplainer(raw: ExplainerRequest, creds: DirectorCredentials, demoMode: boolean, call = structuredCall): Promise<ExplainerResponse> {
  const topic = typeof raw.topic === 'string' ? raw.topic.trim().slice(0, 4000) : ''
  if (!topic) throw new ApiError(400, 'Say what the explainer is about')
  const seconds = Math.min(600, Math.max(10, Number(raw.seconds) || 45))
  const req: ExplainerRequest = { topic, seconds, ...(raw.brand ? { brand: raw.brand } : {}), ...(raw.style ? { style: explainerStyle(raw.style).id } : {}) }
  let result: RawExplainer
  let via: string
  let model: string
  if (creds.anthropic || creds.openrouter || creds.fal) ({ result, via, model } = await call(creds, explainerSystem(), explainerUserPrompt(req), rawExplainerSchema, SHAPE, 'medium'))
  else if (demoMode) [result, via, model] = [demoExplainer(req), 'demo', 'local rules']
  else throw new ApiError(400, 'Writing an explainer needs an Anthropic, OpenRouter or fal.ai key (Settings → Providers)')
  const explainer = sanitizeExplainer(result)
  if (!explainer) throw new ApiError(502, 'The Director wrote no usable scenes — try again or say more about the topic')
  return { explainer, via, model }
}
