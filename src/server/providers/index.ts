import type { ProviderId } from '../../shared/types/jobs'
import type { Env } from '../env'
import { createAnthropicAdapter } from './anthropic'
import { createElevenLabsAdapter } from './elevenlabs'
import { createFalAdapter } from './fal'
import { createKlingAdapter } from './kling'
import { createLocalAdapter } from './local'
import { createMockAdapter } from './mock'
import { createOpenRouterAdapter } from './openrouter'
import type { ProviderAdapter } from './types'

export type AdapterMap = Record<ProviderId, ProviderAdapter>

/** Every adapter but RunPod's, which needs the GPU session (createDeps adds it). */
export function createAdapters(env: Env): Omit<AdapterMap, 'runpod'> {
  return {
    mock: createMockAdapter({ env }),
    elevenlabs: createElevenLabsAdapter(),
    kling: createKlingAdapter(),
    fal: createFalAdapter(),
    anthropic: createAnthropicAdapter(),
    openrouter: createOpenRouterAdapter(),
    local: createLocalAdapter({ env }),
  }
}

/** Providers shown in Settings → Providers (mock is controlled by Demo mode instead). */
export const CONFIGURABLE_PROVIDERS: ProviderId[] = ['elevenlabs', 'kling', 'fal', 'anthropic', 'openrouter', 'local', 'runpod']
