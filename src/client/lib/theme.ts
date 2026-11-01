import { THEME_PREFERENCES, type ThemePreference } from '@shared/types/api'
import { computed, ref, watchEffect } from 'vue'
import { desktop } from './desktop'

/**
 * Light / dark UI. The choice lives in the app settings (shared by the browser and the desktop app) and is
 * mirrored in localStorage so index.html can set the right class before the first paint.
 */
const STORAGE_KEY = 'studio.theme'

function stored(): ThemePreference {
  try {
    const value = localStorage.getItem(STORAGE_KEY) as ThemePreference | null
    return value && THEME_PREFERENCES.includes(value) ? value : 'dark'
  } catch {
    return 'dark'
  }
}

const media = window.matchMedia('(prefers-color-scheme: dark)')
const systemDark = ref(media.matches)
media.addEventListener('change', (event) => (systemDark.value = event.matches))

export const themePreference = ref<ThemePreference>(stored())
export const resolvedTheme = computed<'dark' | 'light'>(() =>
  themePreference.value === 'system' ? (systemDark.value ? 'dark' : 'light') : themePreference.value,
)

watchEffect(() => {
  document.documentElement.classList.toggle('dark', resolvedTheme.value === 'dark')
})

/** Applies a theme in this window (and the desktop app's native chrome). Saving it is the caller's job. */
export function applyTheme(preference: ThemePreference) {
  if (!THEME_PREFERENCES.includes(preference)) return
  themePreference.value = preference
  try {
    localStorage.setItem(STORAGE_KEY, preference)
  } catch {
    // private mode / blocked storage: the server copy still wins on the next load
  }
  desktop?.setTheme?.(preference)
}

// The desktop shell starts with the last theme it was told about; keep it in step with this window's.
desktop?.setTheme?.(themePreference.value)
