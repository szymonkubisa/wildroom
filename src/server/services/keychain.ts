import { Entry } from '@napi-rs/keyring'
import type { CredentialField } from '../../shared/types/api'
import type { ProviderId } from '../../shared/types/jobs'

export type Credentials = Partial<Record<CredentialField, string>>

/**
 * Whose secret it is: a provider's keys, or secrets that belong to no provider card — `comfyui` (the access token the
 * app gives its ComfyUI pods) and `hf` (the Hugging Face token that downloads gated models onto a GPU volume).
 */
export type SecretScope = ProviderId | 'comfyui' | 'hf'

/** Where provider secrets live. The macOS Keychain in the app; an in-memory map in tests. */
export interface SecretStore {
  get(scope: SecretScope, field: CredentialField): string | undefined
  set(scope: SecretScope, field: CredentialField, value: string): void
  delete(scope: SecretScope, field: CredentialField): void
}

const SERVICE = 'wildroom'

export class KeychainSecretStore implements SecretStore {
  private cache = new Map<string, string | undefined>()

  private entry(provider: SecretScope, field: CredentialField) {
    return new Entry(SERVICE, `${provider}.${field}`)
  }

  get(provider: SecretScope, field: CredentialField): string | undefined {
    const key = `${provider}.${field}`
    if (this.cache.has(key)) return this.cache.get(key)
    let value: string | undefined
    try {
      value = this.entry(provider, field).getPassword() ?? undefined
    } catch (err) {
      console.error(`[keychain] read ${key} failed`, err)
      value = undefined
    }
    this.cache.set(key, value)
    return value
  }

  set(provider: SecretScope, field: CredentialField, value: string) {
    this.entry(provider, field).setPassword(value)
    this.cache.set(`${provider}.${field}`, value)
  }

  delete(provider: SecretScope, field: CredentialField) {
    try {
      this.entry(provider, field).deletePassword()
    } catch {
      // already absent
    }
    this.cache.set(`${provider}.${field}`, undefined)
  }
}

export class MemorySecretStore implements SecretStore {
  private map = new Map<string, string>()
  get(provider: SecretScope, field: CredentialField) {
    return this.map.get(`${provider}.${field}`)
  }
  set(provider: SecretScope, field: CredentialField, value: string) {
    this.map.set(`${provider}.${field}`, value)
  }
  delete(provider: SecretScope, field: CredentialField) {
    this.map.delete(`${provider}.${field}`)
  }
}

export function readCredentials(store: SecretStore, provider: ProviderId, fields: CredentialField[]): Credentials {
  const out: Credentials = {}
  for (const field of fields) {
    const value = store.get(provider, field)
    if (value) out[field] = value
  }
  return out
}

/** "sk_…a1b2" style hint so the UI can show which key is stored without revealing it. */
export function secretHint(value: string | undefined): string | undefined {
  if (!value) return undefined
  return value.length <= 8 ? '••••' : `${value.slice(0, 3)}…${value.slice(-4)}`
}
