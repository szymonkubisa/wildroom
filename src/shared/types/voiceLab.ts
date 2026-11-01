/**
 * Voice Lab: ElevenLabs Voice Design (describe → previews → save) and Instant Voice Cloning (project audio → voice).
 * Request/response shapes of POST /api/voices/design, /api/voices/design/save and /api/voices/clone.
 */

export const VOICE_LAB_LIMITS = {
  /** ElevenLabs `voice_description`: 20–1000 characters. */
  descriptionMin: 20,
  descriptionMax: 1000,
  /** Optional preview text: 100–1000 characters (left empty, ElevenLabs writes one). */
  sampleTextMin: 100,
  sampleTextMax: 1000,
  /** Our own cap for voice names. */
  nameMax: 100,
  /** Samples per clone request. */
  cloneFilesMax: 25,
} as const

export interface VoiceDesignRequest {
  description: string
  text?: string
}

export interface VoiceDesignPreviewDTO {
  /** Pass to /voices/design/save to keep this voice. */
  generatedVoiceId: string
  /** `data:` URL the browser can play directly. */
  audioUrl: string
  mediaType: string
  durationSeconds?: number
  language?: string
}

export interface VoiceDesignResponse {
  previews: VoiceDesignPreviewDTO[]
  /** Text the previews speak (the sample text, or one ElevenLabs wrote). */
  text?: string
}

export interface VoiceDesignSaveRequest {
  name: string
  description: string
  generatedVoiceId: string
}

export interface VoiceCloneRequest {
  name: string
  description?: string
  /** Project audio assets (originals are uploaded) or video assets (their extracted audio). */
  assetIds: string[]
  /** Must be true: the user owns the voice or has the speaker's permission. */
  consent: boolean
  removeBackgroundNoise?: boolean
}

export interface VoiceCreatedResponse {
  voiceId: string
  name: string
  /** ElevenLabs flags some clones for verification before use. */
  requiresVerification?: boolean
}
