import type { ProviderId } from '@shared/types/jobs'
import type { ShortcutInfo } from '@/lib/shortcuts'
import type { ProviderMeta } from './providers'
import { SETTINGS_TABS, type SettingsTab } from './settingsSheet'

/**
 * One setting as Settings lists it and its search finds it. The words searched are the ones on screen (label,
 * description, group, tab) plus `keywords` for what its control offers (e.g. a theme's "dark", a GPU's "volume").
 */
export interface SettingsRow {
  id: string
  tab: SettingsTab
  group: string
  label: string
  description?: string
  keywords?: string
  /** row: a control beside the label · block: the control below it · card: draws itself (a provider) · key: a shortcut. */
  layout: 'row' | 'block' | 'card' | 'key'
  /** Provider cards: which provider. */
  provider?: ProviderId
  /** Shortcuts: the keys. */
  keys?: string
}

export interface SettingsRowsContext {
  providers: ProviderMeta[]
  shortcuts: ShortcutInfo[]
  /** A project is open under the sheet (its Plan models can be set). */
  project: boolean
}

/** Every setting the app has, tab by tab, in the order they are shown. Only real, working settings. */
export function settingsRows(ctx: SettingsRowsContext): SettingsRow[] {
  const rows: SettingsRow[] = [
    { id: 'theme', tab: 'general', group: 'Appearance', label: 'Theme', description: 'System follows your Mac’s appearance.', keywords: 'dark light system mode colour color', layout: 'row' },
    {
      id: 'demo',
      tab: 'general',
      group: 'Generation',
      label: 'Demo mode',
      description: 'Free local generators (test patterns, tones, placeholder transcripts) so you can learn the workflow without spending credits.',
      keywords: 'free test mock placeholder stand-in',
      layout: 'row',
    },
    {
      id: 'cloud-one',
      tab: 'general',
      group: 'Rendering',
      label: 'Cloud jobs one at a time',
      description: 'Local renders always go one by one. Off: cloud jobs run in parallel — faster, but you can’t stop the rest after a bad first result.',
      keywords: 'queue parallel activity renders concurrency',
      layout: 'row',
    },
    { id: 'ffmpeg', tab: 'general', group: 'Tools', label: 'ffmpeg', description: 'Leave empty to use the bundled build, or point to your own (e.g. Homebrew).', keywords: 'export encoder path binary', layout: 'block' },

    ...ctx.providers.map(
      (m): SettingsRow => ({
        id: `provider:${m.id}`,
        tab: 'providers',
        group: 'Providers',
        label: m.name,
        description: m.tagline,
        keywords: ['api key keychain provider connect', m.short, m.note, ...m.fields.map((f) => f.label)].filter(Boolean).join(' '),
        layout: 'card',
        provider: m.id,
      }),
    ),

    ...(ctx.project
      ? [
          {
            id: 'plan-models',
            tab: 'models',
            group: 'This project',
            label: 'Plan models',
            description: 'The stills’ image model, the draft and final video models with their render settings, and the dialogue voices — for this project’s Plan.',
            keywords: 'story image video voice draft final stills keyframes resolution',
            layout: 'block',
          } satisfies SettingsRow,
        ]
      : []),
    {
      id: 'models-defaults',
      tab: 'models',
      group: 'Generate',
      label: 'Default models',
      description: 'Generate picks a model for each job from its preset, or the one you choose there.',
      keywords: 'default image video voice quality draft final auto',
      layout: 'block',
    },

    { id: 'director-model', tab: 'director', group: 'Model', label: 'Director model', description: 'Writes scripts, outlines, shots and prompts, and checks frames. Any text model on OpenRouter.', keywords: 'ai llm claude gpt gemini openrouter text', layout: 'block' },
    { id: 'director-route', tab: 'director', group: 'Route', label: 'Route', description: 'Which key runs the Director: Anthropic directly, or through OpenRouter or fal.ai.', keywords: 'anthropic openrouter fal automatic key billing', layout: 'block' },
    {
      id: 'director-used',
      tab: 'director',
      group: 'Used for',
      label: 'Used for',
      description: 'Plan → script, outline and shots · Create → Brief → asset set · Generate → Enhance prompt · Media → Describe with AI · AI tools → continuity check and smart reframe.',
      layout: 'block',
    },

    {
      id: 'runpod',
      tab: 'gpu',
      group: 'RunPod',
      label: 'RunPod GPU for LTX-2.5',
      description: 'The network volume with the models, which GPUs to rent (in order), and when an idle GPU stops.',
      keywords: 'volume network data center gpus rent idle stop hugging face token prepare comfyui ltx cloud pod balance',
      layout: 'block',
    },

    {
      id: 'mcp-enabled',
      tab: 'integrations',
      group: 'Claude (MCP)',
      label: 'Let Claude use the app',
      description: 'Claude Code and Claude Desktop can create projects, build explainers, generate and edit — from this Mac only, with this app’s token.',
      keywords: 'mcp claude code desktop anthropic agent ai automation api',
      layout: 'row',
    },
    {
      id: 'mcp-cap',
      tab: 'integrations',
      group: 'Claude (MCP)',
      label: 'Spend cap per Claude session',
      description: 'Every paid render comes back to you with its price first; this is the most one session may spend in all (estimated USD).',
      keywords: 'mcp budget money limit cost paid usd',
      layout: 'row',
    },
    {
      id: 'mcp-connect',
      tab: 'integrations',
      group: 'Connect',
      label: 'Connect Claude',
      description: 'Run one of these once; Claude then lists the app’s tools.',
      keywords: 'mcp token endpoint claude code desktop config snippet setup stdio bridge http',
      layout: 'block',
    },

    {
      id: 'projects-folder',
      tab: 'storage',
      group: 'Folders',
      label: 'Projects folder',
      description: 'Where new projects go. Each project is a self-contained folder — move or copy it anywhere and open it with Open….',
      keywords: 'location path directory finder',
      layout: 'row',
    },
    { id: 'cache', tab: 'storage', group: 'Folders', label: 'Cache', description: 'Proxies, thumbnails and waveforms. Kept out of project folders and rebuilt automatically when needed.', keywords: 'clear space disk', layout: 'row' },
    { id: 'local-models', tab: 'storage', group: 'Folders', label: 'Local models', description: 'FLUX.2 and LTX-2.5 for this Mac.', keywords: 'mlx flux ltx disk path', layout: 'row' },

    ...ctx.shortcuts.map(
      (s, i): SettingsRow => ({ id: `shortcut:${i}`, tab: 'shortcuts', group: s.group, label: s.action, keys: s.keys, keywords: `${s.keys} shortcut keyboard`, layout: 'key' }),
    ),

    { id: 'walkthrough', tab: 'help', group: 'Learn', label: 'Walkthrough', description: 'A two-minute guided tour of the editor. It opens your most recent project and highlights each area in turn.', keywords: 'tour guide help start', layout: 'row' },
    { id: 'features', tab: 'help', group: 'Learn', label: 'All features', description: 'Every feature in one searchable list — what it does, how to use it, its shortcut and which key it needs.', keywords: 'help guide list', layout: 'row' },
  ]
  return rows
}

const tabLabel = (tab: SettingsTab) => SETTINGS_TABS.find((t) => t.id === tab)?.label ?? tab

/** Every word typed must be found somewhere in what the row says (its label, description, group, tab or keywords). */
export function matchesSetting(row: SettingsRow, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const text = [row.label, row.description, row.group, tabLabel(row.tab), row.keywords, row.keys].filter(Boolean).join(' ').toLowerCase()
  return words.every((w) => text.includes(w))
}

/** The rows that match, in tab order, and how many matched in each tab. */
export function searchSettings(rows: SettingsRow[], query: string): { rows: SettingsRow[]; counts: Record<SettingsTab, number> } {
  const counts = Object.fromEntries(SETTINGS_TABS.map((t) => [t.id, 0])) as Record<SettingsTab, number>
  const hits = rows.filter((r) => matchesSetting(r, query))
  for (const r of hits) counts[r.tab]++
  const order = (tab: SettingsTab) => SETTINGS_TABS.findIndex((t) => t.id === tab)
  return { rows: hits.map((r, i) => [r, i] as const).sort((a, b) => order(a[0].tab) - order(b[0].tab) || a[1] - b[1]).map(([r]) => r), counts }
}

/** Rows under their headings, the headings in the order they first come. */
export function groupRows(rows: SettingsRow[]): { group: string; rows: SettingsRow[] }[] {
  const groups = new Map<string, SettingsRow[]>()
  for (const row of rows) groups.set(row.group, [...(groups.get(row.group) ?? []), row])
  return [...groups].map(([group, list]) => ({ group, rows: list }))
}
