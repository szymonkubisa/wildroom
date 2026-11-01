import { toggled } from '@shared/models/favorites'
import { computed } from 'vue'
import { toast } from 'vue-sonner'
import { errorMessage } from '@/lib/api'
import { useSettingsStore } from '@/stores/settings'

/**
 * Starred models, kept in the app settings (the same on the web and the desktop app): on top of the Composer's model
 * menu, in the order starred; the first ready one of a kind is picked when the Composer opens on that kind
 * (firstFavorite).
 */
export function useFavorites() {
  const settings = useSettingsStore()
  const list = computed(() => settings.app?.favoriteModels ?? [])
  async function toggle(id: string) {
    try {
      await settings.update({ favoriteModels: toggled(list.value, id) })
    } catch (err) {
      toast.error('Could not save the favourite', { description: errorMessage(err) })
    }
  }
  return { list, toggle }
}
