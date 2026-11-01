import Anthropic from '@anthropic-ai/sdk'
import type { ProviderTestResult } from '../../shared/types/api'
import type { Credentials } from '../services/keychain'
import { type ProviderAdapter, ProviderError, jobError } from './types'

/**
 * Anthropic is not a media generator — its key powers the AI Director (script breakdown, prompt help)
 * with native structured outputs. Registered as a provider so the key lives in Settings/Keychain.
 */
export function createAnthropicAdapter(): ProviderAdapter {
  return {
    id: 'anthropic',
    label: 'Anthropic',
    version: '2026-09-29.1',
    credentialFields: ['apiKey'],
    requiredFields: ['apiKey'],
    defaultConcurrency: 2,
    pollIntervalMs: 2000,
    async test(credentials: Credentials): Promise<ProviderTestResult> {
      const client = new Anthropic({ apiKey: credentials.apiKey })
      try {
        await client.models.retrieve('claude-opus-5-5')
        return { ok: true, message: 'Connected — the AI Director will use Claude Opus 5.5 directly.' }
      } catch (err) {
        if (err instanceof Anthropic.AuthenticationError) return { ok: false, message: 'Invalid API key' }
        if (err instanceof Anthropic.PermissionDeniedError) return { ok: false, message: 'This key cannot access Claude Opus 5.5' }
        if (err instanceof Anthropic.APIError) return { ok: false, message: `Anthropic API error ${err.status}: ${err.message}` }
        return { ok: false, message: err instanceof Error ? err.message : String(err) }
      }
    },
    async submit() {
      throw new ProviderError(jobError('invalid_params', 'Anthropic is used by the AI Director, not for media generation'))
    },
  }
}
