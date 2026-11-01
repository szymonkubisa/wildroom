import { DEFAULT_TEXT_CHOICE, type LlmRoute, type TextModelChoice, type TextModelInfo, shortModelName } from '@shared/types/llm'
import { computed, effectScope, ref, watch } from 'vue'
import { api } from '@/lib/api'
import { sharedList } from '@/lib/sharedList'
import { onServerReconnect } from '@/lib/sse'
import { useSettingsStore } from '@/stores/settings'

export type DirectorVia = 'anthropic' | 'openrouter' | 'fal' | 'demo' | 'none'

export const ROUTE_LABELS: Record<LlmRoute, string> = {
  auto: 'Automatic',
  anthropic: 'Anthropic',
  openrouter: 'OpenRouter',
  fal: 'fal.ai',
}

export const VIA_LABELS: Record<DirectorVia, string> = {
  anthropic: 'Anthropic',
  openrouter: 'OpenRouter',
  fal: 'fal.ai',
  demo: 'demo rules (no AI)',
  none: 'no key yet',
}

// One shared copy of OpenRouter's catalogue per page load.
const textModels = sharedList<TextModelInfo>(() => api.director.models())
const models = textModels.items
const modelsError = textModels.error

export const loadTextModels = textModels.load

/** `reason`: why a set key can't run the chosen route/model (none / demo only). */
const status = ref<{ via: DirectorVia; model: string; reason?: string }>()

async function refreshStatus() {
  try {
    status.value = await api.director.status()
  } catch {
    status.value = { via: 'none', model: DEFAULT_TEXT_CHOICE.model }
  }
}

let watching = false

/** The Director's model choice, what actually runs it now, and OpenRouter's catalogue. */
export function useTextModels() {
  const settings = useSettingsStore()
  const choice = computed<TextModelChoice>(() => settings.app?.textModel ?? DEFAULT_TEXT_CHOICE)
  if (!watching) {
    watching = true
    // Detached: made in the first caller's setup, the watch would stop when that component unmounts and never be made
    // again — a key added in Settings would leave Story's buttons disabled until a reload.
    effectScope(true).run(() => {
      // Keys or the choice changed: the route may differ now.
      watch(
        () => [settings.app?.textModel?.route, settings.app?.textModel?.model, settings.providers.map((p) => `${p.id}:${p.configured}`).join(',')],
        () => void refreshStatus(),
        { immediate: true },
      )
    })
    // A status call that failed while the server restarted left 'none'.
    onServerReconnect(() => void refreshStatus())
  }
  const current = computed(() => models.value.find((m) => m.id === choice.value.model))
  const label = computed(() => {
    const s = status.value
    if (!s) return '…'
    const name = models.value.find((m) => m.id === s.model)?.name ?? shortModelName(s.model)
    if (s.via === 'none' || s.via === 'demo') return VIA_LABELS[s.via]
    return `${name} · ${VIA_LABELS[s.via]}`
  })

  async function setChoice(patch: Partial<TextModelChoice>) {
    await settings.update({ textModel: { ...choice.value, ...patch } })
  }

  return { models, modelsError, status, choice, current, label, setChoice, loadModels: loadTextModels }
}

/** "$4 / $20" per million tokens (input / output), or "free". */
export function priceLabel(m: Pick<TextModelInfo, 'inputPrice' | 'outputPrice'>): string {
  if (m.inputPrice === undefined || m.outputPrice === undefined) return ''
  if (m.inputPrice === 0 && m.outputPrice === 0) return 'free'
  const f = (n: number) => (n >= 10 ? n.toFixed(0) : n >= 1 ? n.toFixed(2).replace(/\.?0+$/, '') : n.toFixed(2))
  return `$${f(m.inputPrice)} / $${f(m.outputPrice)}`
}

/** A text model's name for people: the catalogue's ("Claude Opus 5.5"), else its id tidied up ("claude-opus-5.5" → "Claude Opus 5.5"). */
export function textModelName(id: string | undefined, catalogue: readonly TextModelInfo[] = []): string {
  if (!id) return 'the Director'
  const known = catalogue.find((m) => m.id === id)?.name
  if (known) return known
  return shortModelName(id)
    .split(/[-_\s]+/)
    .map((w) => (/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ')
}
