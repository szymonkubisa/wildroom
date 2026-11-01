import type { AppSettings, ProviderStatus } from '@shared/types/api'
import type { ProviderId } from '@shared/types/jobs'
import { allModels } from '@shared/models/registry'
import type { ModelSpec } from '@shared/models/types'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api } from '@/lib/api'
import { onServerEvent, onServerReconnect } from '@/lib/sse'
import { applyTheme } from '@/lib/theme'

export const useSettingsStore = defineStore('settings', () => {
  const app = ref<AppSettings>()
  const providers = ref<ProviderStatus[]>([])
  const loaded = ref(false)

  async function load(attempt = 0): Promise<void> {
    let a: AppSettings, p: ProviderStatus[]
    try {
      ;[a, p] = await Promise.all([api.settings.get(), api.settings.providers()])
    } catch (err) {
      // The server may still be starting (or restarting): retry rather than show every provider as not set up. Past the
      // retries the event stream's reconnect loads them once the server answers (onServerReconnect below).
      if (loaded.value) throw err
      if (attempt >= 5) return console.warn('Settings could not be loaded yet — waiting for the server', err)
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt))
      return load(attempt + 1)
    }
    app.value = a
    providers.value = p
    loaded.value = true
    if (a.theme) applyTheme(a.theme)
  }

  function providerReady(id: ProviderId): boolean {
    if (id === 'mock') return Boolean(app.value?.demoMode)
    return Boolean(providers.value.find((p) => p.id === id)?.configured)
  }

  /** The provider is ready and, when it reports models one by one (local models), this one is installed. */
  function modelReady(m: ModelSpec): boolean {
    if (!providerReady(m.provider)) return false
    return providers.value.find((p) => p.id === m.provider)?.models?.[m.id]?.ready ?? true
  }

  /** Models the user can run right now (configured provider, or demo mode for mock). */
  const availableModels = computed<ModelSpec[]>(() => allModels().filter(modelReady))

  async function update(patch: Partial<AppSettings>) {
    app.value = await api.settings.update(patch)
  }

  onServerEvent((event) => {
    if (event.type === 'settings.changed' && loaded.value) void load()
  })
  // Back after a restart (or reachable at last): providers may have changed, or never loaded — the GPU chip needs them.
  onServerReconnect(() => void load().catch(() => undefined))

  return { app, providers, loaded, load, providerReady, modelReady, availableModels, update }
})
