import { ref } from 'vue'

/**
 * The Story workspace's timeline drawer. `active`: it was clicked into last — its keys (Delete, Space, blade…) then act
 * on the timeline, as in Video; a click anywhere else in the story gives them back. `skim`: what an Assets panel in the
 * story is skimming, shown in the drawer's viewer as Video's viewer shows it.
 */
export const drawerActive = ref(false)
export const storySkim = ref<{ assetId: string; seconds: number }>()
