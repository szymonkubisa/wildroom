import type { ProviderId } from '@shared/types/jobs'
import { defineStore } from 'pinia'
import { ref } from 'vue'

export type SettingsTab = 'general' | 'providers' | 'models' | 'director' | 'gpu' | 'integrations' | 'storage' | 'shortcuts' | 'help'

export interface SettingsTabInfo {
  id: SettingsTab
  label: string
  blurb: string
}

/** In this order on top of Settings: General first, then what is set up once, then what is looked up. */
export const SETTINGS_TABS: SettingsTabInfo[] = [
  { id: 'general', label: 'General', blurb: 'Theme, demo mode, how renders queue, and the ffmpeg build.' },
  { id: 'providers', label: 'Providers', blurb: 'API keys for the AI models. Stored in your macOS Keychain; only the local server uses them.' },
  { id: 'models', label: 'Models', blurb: 'Which models the app renders with.' },
  { id: 'director', label: 'Director', blurb: 'The text model behind scripts, briefs, prompt help and frame analysis — Claude, GPT, Gemini or any OpenRouter model.' },
  { id: 'gpu', label: 'GPU', blurb: 'The rented RunPod GPU for LTX-2.5: its model volume, which cards to rent and when to stop.' },
  { id: 'integrations', label: 'Integrations', blurb: 'Let Claude (Claude Code, Claude Desktop) drive the app over MCP: build projects and explainers, generate and edit.' },
  { id: 'storage', label: 'Projects & storage', blurb: 'Where projects, caches and local models live.' },
  { id: 'shortcuts', label: 'Shortcuts', blurb: 'Final Cut Pro–style keys in Edit; the rest work everywhere.' },
  { id: 'help', label: 'Help', blurb: 'Take the tour or browse everything the app can do.' },
]

export function isSettingsTab(value: unknown): value is SettingsTab {
  return SETTINGS_TABS.some((t) => t.id === value)
}

/**
 * Settings as a sheet over whatever is open (the editor stays open under it), or the /settings page — both show the
 * same tab. `provider`: a provider card to open and scroll to (Generate's "Add key"); `focus` changes with every
 * request, so asking for the same card again scrolls to it again.
 */
export const useSettingsSheet = defineStore('settingsSheet', () => {
  const open = ref(false)
  const tab = ref<SettingsTab>('general')
  const provider = ref<ProviderId>()
  const focus = ref(0)

  /** Without a tab or provider it opens where it was left. */
  function show(opts: { tab?: SettingsTab; provider?: ProviderId } = {}) {
    provider.value = opts.provider
    if (opts.provider) {
      tab.value = 'providers'
      focus.value++
    } else if (opts.tab) {
      tab.value = opts.tab
    }
    open.value = true
  }

  return { open, tab, provider, focus, show }
})

/** Opens Settings over the current page: `{ tab: 'director' }`, or `{ provider: 'fal' }` for that provider's key. */
export function openSettings(opts: { tab?: SettingsTab; provider?: ProviderId } = {}) {
  useSettingsSheet().show(opts)
}
