import type { CredentialField } from '@shared/types/api'
import type { ProviderId } from '@shared/types/jobs'

export interface ProviderField {
  field: CredentialField
  label: string
  placeholder: string
  help?: string
  /** Not a secret (shown as typed). */
  plain?: boolean
}

export interface ProviderMeta {
  id: ProviderId
  name: string
  /** A word or two for chips (Home's studio setup card). */
  short: string
  tagline: string
  keysUrl: string
  fields: ProviderField[]
  note?: string
}

export const PROVIDER_META: ProviderMeta[] = [
  {
    id: 'elevenlabs',
    name: 'ElevenLabs',
    short: 'ElevenLabs',
    tagline: 'Voice-over, multi-speaker dialogue (Eleven v4), music and sound effects.',
    keysUrl: 'https://elevenlabs.io/app/settings/api-keys',
    fields: [{ field: 'apiKey', label: 'API key', placeholder: 'sk_…' }],
  },
  {
    id: 'kling',
    name: 'Kling AI',
    short: 'Kling',
    tagline: 'Kling 3.0 / Omni / Turbo video with native audio, first + last frame and multi-shot.',
    keysUrl: 'https://app.klingai.com/global/dev',
    fields: [
      { field: 'apiKey', label: 'API key', placeholder: 'Kling API key', help: 'New API format — required for Kling 3.0 models.' },
      { field: 'accessKey', label: 'Access key (legacy)', placeholder: 'Optional', help: 'Only for the elements library and advanced lip-sync.' },
      { field: 'secretKey', label: 'Secret key (legacy)', placeholder: 'Optional' },
    ],
  },
  {
    id: 'fal',
    name: 'fal.ai',
    short: 'fal.ai',
    tagline: 'One key for Veo 3.1, Seedance, Wan, MiniMax, image models, lip-sync, upscaling and LLMs.',
    keysUrl: 'https://fal.ai/dashboard/keys',
    fields: [{ field: 'apiKey', label: 'API key', placeholder: 'key-id:key-secret' }],
    note: 'Input images/audio you use with fal models are uploaded to fal storage.',
  },
  {
    id: 'anthropic',
    name: 'Anthropic (optional)',
    short: 'Anthropic',
    tagline: 'Runs Claude models for the AI Director directly, with native structured outputs. Without it, the Director uses OpenRouter or fal.ai.',
    keysUrl: 'https://platform.claude.com/settings/keys',
    fields: [{ field: 'apiKey', label: 'API key', placeholder: 'sk-ant-…' }],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter (optional)',
    short: 'OpenRouter',
    tagline:
      'One key for hundreds of text models — Claude, GPT, Gemini, DeepSeek… — for the AI Director (pick it in Settings › Director), for image models in the Composer: GPT Image 2.5, Nano Banana, Seedream 5, FLUX.3, Recraft and any other OpenRouter lists — and for Seedance 2.5 video, which can follow a Blender previs.',
    keysUrl: 'https://openrouter.ai/settings/keys',
    fields: [
      { field: 'apiKey', label: 'API key', placeholder: 'sk-or-v1-…' },
      {
        field: 'uploadTarget',
        label: 'Camera-guide upload (optional)',
        placeholder: 'user@your-server:/var/www/html/wildroom-tmp',
        help: 'Seedance fetches a Blender previs only from a public https address: the app copies it to this folder with scp (your SSH key) for the length of the job, then deletes it.',
        plain: true,
      },
      { field: 'uploadUrl', label: 'Camera-guide address', placeholder: 'https://your-server/wildroom-tmp/', help: 'Where your web server serves that folder.', plain: true },
    ],
    note: 'Prompts, and the frames, reference images or camera guides you use, are sent to the model provider you pick through OpenRouter. Images and videos are billed only when they finish.',
  },
  {
    id: 'runpod',
    name: 'RunPod GPU (LTX-2.5)',
    short: 'RunPod GPU',
    tagline:
      'Rents a cloud GPU only while it renders: LTX-2.5 at full quality — up to 4K, reference images — through ComfyUI. Billed per second; stops by itself when the queue is empty.',
    keysUrl: 'https://console.runpod.io/user/settings',
    fields: [{ field: 'apiKey', label: 'API key', placeholder: 'rpa_…', help: 'Needs read/write access (pods and network volumes).' }],
    note: 'The models live on a RunPod network volume in one data center (billed monthly); GPUs start there on demand. Your inputs and prompts are sent to the pod; renders come back into the project.',
  },
  {
    id: 'local',
    name: 'This Mac (FLUX.2 + LTX-2.5)',
    short: 'This Mac',
    tagline:
      'Free, private generation on Apple Silicon (MLX) — no key, no upload. FLUX.2 [klein] for images (the default), Lightricks LTX-2.5 for video with audio and start/end frames.',
    keysUrl: 'https://huggingface.co/mflux-community/flux2-klein-4b-mflux-q4',
    fields: [],
    note: 'Images: pnpm models:flux2 (mflux + 13 GB: Fast and Quality modes, Apache-2.0); pnpm models:flux2-max adds the 9B Max mode (9.5 GB, non-commercial). Video: pnpm models:ltx (~31 GB; accept the model licence on Hugging Face once). Renders run one at a time and use most of the memory on a 16 GB Mac.',
  },
]
