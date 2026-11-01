import { describe, expect, it } from 'vitest'
import { SHORTCUTS } from '@/lib/shortcuts'
import { PROVIDER_META } from './providers'
import { groupRows, searchSettings, settingsRows } from './settingsIndex'
import { SETTINGS_TABS } from './settingsSheet'

const rows = settingsRows({ providers: PROVIDER_META, shortcuts: SHORTCUTS, project: false })

describe('Settings', () => {
  it('has its tabs in order, General first, and something in every one', () => {
    expect(SETTINGS_TABS.map((t) => t.label)).toEqual(['General', 'Providers', 'Models', 'Director', 'GPU', 'Integrations', 'Projects & storage', 'Shortcuts', 'Help'])
    for (const tab of SETTINGS_TABS) expect(rows.some((r) => r.tab === tab.id), tab.id).toBe(true)
  })

  it('lists project-only rows only in a project', () => {
    expect(rows.some((r) => r.id === 'plan-models')).toBe(false)
    const more = settingsRows({ providers: PROVIDER_META, shortcuts: SHORTCUTS, project: true })
    expect(more.some((r) => r.id === 'plan-models')).toBe(true)
  })

  it('finds settings in every tab by what they say and offer, counting hits per tab', () => {
    const gpu = searchSettings(rows, 'gpu')
    expect(gpu.counts.gpu).toBe(1)
    expect(gpu.counts.providers).toBeGreaterThan(0) // RunPod's card
    expect(searchSettings(rows, 'dark').rows.map((r) => r.id)).toEqual(['theme'])
    expect(searchSettings(rows, 'fal').rows.some((r) => r.id === 'provider:fal')).toBe(true)
    // Every word must match, in any order.
    expect(searchSettings(rows, 'cache clear').rows.map((r) => r.id)).toEqual(['cache'])
    expect(searchSettings(rows, 'blade').counts.shortcuts).toBeGreaterThan(0)
    expect(searchSettings(rows, 'zzzz').rows).toEqual([])
  })

  it('keeps the hits in tab order', () => {
    const tabs = searchSettings(rows, 'key').rows.map((r) => SETTINGS_TABS.findIndex((t) => t.id === r.tab))
    expect(tabs).toEqual([...tabs].sort((a, b) => a - b))
  })

  it('groups rows under their headings', () => {
    const groups = groupRows(rows.filter((r) => r.tab === 'shortcuts'))
    expect(new Set(groups.map((g) => g.group)).size).toBe(groups.length)
  })
})
