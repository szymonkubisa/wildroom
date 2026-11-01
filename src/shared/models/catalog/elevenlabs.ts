import { z } from 'zod'
import { P, param } from '../params'
import type { CostEstimate, ModelSpec, ParamDef, ParamValues } from '../types'

const AS_OF = '2026-09-28'

/** Text-to-dialogue limits (per request). */
export const ELEVENLABS_DIALOGUE_MAX_CHARS = 2000
export const ELEVENLABS_DIALOGUE_MAX_VOICES = 10
export const ELEVENLABS_DIALOGUE_MODEL = 'eleven_v4'
export const ELEVENLABS_SFX_MODEL = 'eleven_text_to_sound_v2'
export const ELEVENLABS_MUSIC_MODEL = 'music_v2_5'

export interface ElevenLabsTtsVariant {
  /** Catalog model id. */
  id: string
  /** ElevenLabs `model_id`. */
  apiModelId: string
  label: string
  description: string
  badges: string[]
  maxChars: number
  /**
   * Voice settings the model honours. `stability: 'presets'` = only 0 / 0.5 / 1 (Creative / Natural / Robust).
   * `speakerBoost` is sent as `use_speaker_boost: true` for models that support it.
   */
  settings: { stability: 'slider' | 'presets'; similarity: boolean; style: boolean; speed: boolean; speakerBoost: boolean }
  /** API credits per character, when published. */
  creditsPerChar: number | null
}

/** Text-to-speech models. The adapter reads `apiModelId` / `settings` from here. */
export const ELEVENLABS_TTS_VARIANTS: ElevenLabsTtsVariant[] = [
  {
    id: 'eleven-v4-tts',
    apiModelId: 'eleven_v4',
    label: 'Eleven v4',
    description: 'Most expressive ElevenLabs voice model — direct delivery with inline tags like [whispering] or [laughing].',
    badges: ['New', 'Audio tags'],
    maxChars: 10_000,
    settings: { stability: 'slider', similarity: true, style: false, speed: false, speakerBoost: false },
    creditsPerChar: null,
  },
  {
    id: 'eleven-v4-turbo-tts',
    apiModelId: 'eleven_v4_turbo',
    label: 'Eleven v4 Turbo',
    description: 'Faster v4 variant for drafts and long reads; supports the same inline audio tags.',
    badges: ['New', 'Fast', 'Audio tags'],
    maxChars: 10_000,
    settings: { stability: 'slider', similarity: true, style: false, speed: false, speakerBoost: false },
    creditsPerChar: null,
  },
  {
    id: 'eleven-v3-tts',
    apiModelId: 'eleven_v3',
    label: 'Eleven v3',
    description: 'Previous expressive model with audio tags; stability is Creative / Natural / Robust.',
    badges: ['Audio tags'],
    maxChars: 5_000,
    settings: { stability: 'presets', similarity: false, style: false, speed: false, speakerBoost: false },
    creditsPerChar: 1,
  },
  {
    id: 'eleven-multilingual-v2-tts',
    apiModelId: 'eleven_multilingual_v2',
    label: 'Multilingual v2',
    description: 'Consistent, natural narration in 29 languages with style and speed control.',
    badges: ['Stable', 'Style'],
    maxChars: 10_000,
    settings: { stability: 'slider', similarity: true, style: true, speed: true, speakerBoost: true },
    creditsPerChar: 1,
  },
  {
    id: 'eleven-flash-v2.5-tts',
    apiModelId: 'eleven_flash_v2_5',
    label: 'Flash v2.5',
    description: 'Lowest-latency, half-price model for scratch dialogue and temp tracks.',
    badges: ['Fast', 'Budget'],
    maxChars: 40_000,
    settings: { stability: 'slider', similarity: true, style: false, speed: true, speakerBoost: true },
    creditsPerChar: 0.5,
  },
]

export function elevenLabsTtsVariant(modelId: string): ElevenLabsTtsVariant | undefined {
  return ELEVENLABS_TTS_VARIANTS.find((v) => v.id === modelId)
}

export interface DialogueLine {
  voiceId: string
  text: string
}

/** Characters billed/limited for a dialogue request (sum of all line texts). */
export function dialogueCharCount(lines: unknown): number {
  if (!Array.isArray(lines)) return 0
  return lines.reduce((sum: number, line) => sum + (typeof line?.text === 'string' ? line.text.length : 0), 0)
}

// ------------------------------------------------------------------------------------------- params

const stabilitySlider = () =>
  P.slider('stability', 'Stability', 0, 1, 0.05, 0.5, {
    help: 'Lower = more expressive and varied, higher = steadier and more consistent',
  })

const stabilityPresets = () =>
  P.segmented('stability', 'Stability', [0, 0.5, 1] as const, 0.5, {
    labels: (v) => (v === 0 ? 'Creative' : v === 0.5 ? 'Natural' : 'Robust'),
    help: 'Creative is most expressive but can hallucinate; Robust is steady but less responsive to tags',
  })

const similaritySlider = () =>
  P.slider('similarity', 'Similarity', 0, 1, 0.05, 0.75, {
    help: 'How closely to match the original voice (too high can reproduce artefacts)',
    advanced: true,
  })

function ttsParams(v: ElevenLabsTtsVariant): ParamDef[] {
  const audioTags = v.badges.includes('Audio tags')
  return [
    P.voice(),
    P.text('text', 'Text', v.maxChars, {
      required: true,
      control: 'prompt',
      placeholder: audioTags ? '[whispering] We are not alone here…' : 'What should the voice say?',
      help: audioTags ? 'Inline audio tags in square brackets steer delivery: [whispering], [laughing], [sighs], [excited]…' : undefined,
    }),
    v.settings.stability === 'presets' ? stabilityPresets() : stabilitySlider(),
    ...(v.settings.similarity ? [similaritySlider()] : []),
    ...(v.settings.style
      ? [P.slider('style', 'Style exaggeration', 0, 1, 0.05, 0, { advanced: true, help: 'Amplifies the speaker’s style; adds latency' })]
      : []),
    ...(v.settings.speed ? [P.slider('speed', 'Speed', 0.7, 1.2, 0.05, 1, { unit: '×', advanced: true })] : []),
    P.seed(),
  ]
}

function credits(chars: number, perChar: number | null, what: string): CostEstimate {
  const count = `${fmtInt(chars)} ${what}`
  if (perChar == null) return { usd: null, detail: `${count} — billed in ElevenLabs credits (rate for this model not published yet)`, asOf: AS_OF }
  return { usd: null, detail: `${count} ≈ ${fmtInt(Math.ceil(chars * perChar))} ElevenLabs credits`, asOf: AS_OF }
}

function fmtInt(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

// ------------------------------------------------------------------------------------------- models

const ttsModels: ModelSpec[] = ELEVENLABS_TTS_VARIANTS.map((v) => ({
  id: v.id,
  label: v.label,
  vendor: 'ElevenLabs',
  provider: 'elevenlabs',
  kind: 'speech',
  description: v.description,
  badges: v.badges,
  output: 'audio',
  defaultRole: 'dialogue',
  params: ttsParams(v),
  estimateCost: (values: ParamValues) =>
    credits(typeof values.text === 'string' ? values.text.length : 0, v.creditsPerChar, 'characters'),
  maxVariants: 1,
}))

const dialogueLineSchema = z.object({
  voiceId: z.string().min(1, 'Pick a voice for every line'),
  text: z.string().trim().min(1, 'Every line needs text'),
})

const dialogueModel: ModelSpec = {
  id: 'eleven-dialogue',
  label: 'Eleven v4 Dialogue',
  vendor: 'ElevenLabs',
  provider: 'elevenlabs',
  kind: 'dialogue',
  description: 'Multi-speaker scene in one take with natural turn-taking; returns per-line timing.',
  badges: ['New', 'Multi-voice', 'Audio tags'],
  output: 'audio',
  defaultRole: 'dialogue',
  params: [
    param('lines', z.array(dialogueLineSchema, { error: 'Add at least one line' }).min(1, 'Add at least one line').max(200), {
      label: 'Lines',
      control: 'text',
      help: `One entry per line: { voiceId, text } in speaking order. Up to ${ELEVENLABS_DIALOGUE_MAX_VOICES} voices and ${fmtInt(ELEVENLABS_DIALOGUE_MAX_CHARS)} characters in total; inline audio tags like [laughs] work.`,
    }),
    stabilitySlider(),
    P.seed(),
  ],
  validate: (values) => {
    const lines = Array.isArray(values.lines) ? (values.lines as DialogueLine[]) : []
    const chars = dialogueCharCount(lines)
    if (chars > ELEVENLABS_DIALOGUE_MAX_CHARS)
      return `Dialogue is ${fmtInt(chars)} characters — ElevenLabs allows ${fmtInt(ELEVENLABS_DIALOGUE_MAX_CHARS)} per request. Split the scene.`
    const voices = new Set(lines.map((l) => l.voiceId))
    if (voices.size > ELEVENLABS_DIALOGUE_MAX_VOICES)
      return `Dialogue uses ${voices.size} voices — at most ${ELEVENLABS_DIALOGUE_MAX_VOICES} per request.`
    return null
  },
  estimateCost: (values) => credits(dialogueCharCount(values.lines), null, 'characters'),
  maxVariants: 1,
}

const sfxModel: ModelSpec = {
  id: 'eleven-sfx',
  label: 'ElevenLabs Sound Effects',
  vendor: 'ElevenLabs',
  provider: 'elevenlabs',
  kind: 'sfx',
  description: 'Sound effects and ambiences from a description, up to 30 s, optionally seamless loops.',
  badges: ['Loop', '30 s'],
  output: 'audio',
  defaultRole: 'effects',
  params: [
    P.prompt({ max: 2000, label: 'Sound', placeholder: 'Heavy wooden door creaks open in a stone hallway' }),
    P.toggle('autoDuration', 'Auto length', true, { help: 'Let the model pick a fitting length' }),
    P.slider('durationSeconds', 'Length', 0.5, 30, 0.5, 5, { unit: 's', visibleIf: (v) => v.autoDuration === false }),
    P.toggle('loop', 'Seamless loop', false),
    P.slider('promptInfluence', 'Prompt influence', 0, 1, 0.05, 0.3, {
      advanced: true,
      help: 'Higher follows the description more literally, lower is more varied',
    }),
  ],
  estimateCost: (values) => ({
    usd: null,
    detail:
      values.autoDuration === false && typeof values.durationSeconds === 'number'
        ? `${values.durationSeconds} s sound effect — billed in ElevenLabs credits`
        : 'Sound effect — billed in ElevenLabs credits',
    asOf: AS_OF,
  }),
  maxVariants: 1,
}

const musicModel: ModelSpec = {
  id: 'eleven-music',
  label: 'Eleven Music',
  vendor: 'ElevenLabs',
  provider: 'elevenlabs',
  kind: 'music',
  description: 'Full songs or instrumentals from a prompt, 3 s – 10 min (paid ElevenLabs plans only).',
  badges: ['Vocals', 'Instrumental', '10 min'],
  output: 'audio',
  defaultRole: 'music',
  params: [
    P.prompt({
      max: 4000,
      label: 'Music',
      placeholder: 'Tense orchestral underscore, low strings and pulsing synth, builds to a climax',
      help: 'Describe genre, mood, instruments and structure. Artist or song names are rejected.',
    }),
    P.slider('durationSeconds', 'Length', 3, 600, 1, 30, { unit: 's' }),
    P.toggle('instrumental', 'Instrumental only', true, { help: 'Guarantee no vocals' }),
  ],
  estimateCost: (values) => ({
    usd: null,
    detail: `${typeof values.durationSeconds === 'number' ? `${values.durationSeconds} s of music` : 'Music'} — billed in ElevenLabs credits (paid plans)`,
    asOf: AS_OF,
  }),
  maxVariants: 1,
}

export const elevenLabsModels: ModelSpec[] = [...ttsModels, dialogueModel, sfxModel, musicModel]
