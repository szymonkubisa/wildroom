<script setup lang="ts">
import { Plus } from '@lucide/vue'
import type { ParamDef, ParamValues } from '@shared/models/types'
import type { AssetKind } from '@shared/types/assets'
import { ref } from 'vue'
import { toast } from 'vue-sonner'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ASSET_DRAG_TYPE, readAssetDrag } from '@/features/assets/drag'
import { useAssetsStore } from '@/stores/assets'
import AssetSlot from './AssetSlot.vue'
import ComposerTile from './ComposerTile.vue'
import ReferencePicker from './ReferencePicker.vue'

/**
 * The pictures, clips and sounds the model takes, as tiles in the row above the prompt: a start and an end frame, the
 * image to edit, a clip, a sound — each one tile (drop on it, or click to pick) — and its reference pictures as one
 * tile, "References 2/10", that opens them — picked from what was generated, uploaded, the cast and places, the
 * favourites (drop on it to add). Which tiles there are comes from the model's params,
 * so another model shows its own.
 */
const props = defineProps<{ params: ParamDef[]; values: ParamValues; errors: Record<string, string | undefined> }>()
const emit = defineEmits<{ set: [key: string, value: unknown] }>()
const assets = useAssetsStore()

const kindOf = (p: ParamDef): AssetKind => (p.ui.control === 'video' ? 'video' : p.ui.control === 'audio' ? 'audio' : 'image')
const listOf = (p: ParamDef): string[] => (Array.isArray(props.values[p.key]) ? (props.values[p.key] as string[]) : [])
const maxOf = (p: ParamDef) => p.ui.maxItems ?? 4
const posterOf = (id: string) => (assets.get(id)?.variants.poster ? `/media/${id}/poster` : undefined)

// Pictures dropped on the References tile: added, up to the model's limit.
const over = ref<string>()
function onDragOver(p: ParamDef, e: DragEvent) {
  if (!e.dataTransfer?.types.includes(ASSET_DRAG_TYPE)) return
  e.preventDefault()
  e.stopPropagation()
  over.value = p.key
}
function onDrop(p: ParamDef, e: DragEvent) {
  over.value = undefined
  const ids = readAssetDrag(e.dataTransfer)?.filter((id) => assets.get(id)?.kind === 'image')
  if (!ids?.length) return
  e.preventDefault()
  e.stopPropagation()
  const list = listOf(p)
  const next = [...list, ...ids.filter((id) => !list.includes(id))]
  if (next.length > maxOf(p)) toast.warning(`This model takes up to ${maxOf(p)} — the first ${maxOf(p)} are in`)
  emit('set', p.key, next.slice(0, maxOf(p)))
}
</script>

<template>
  <template v-for="p in params" :key="p.key">
    <Popover v-if="p.ui.control === 'images' && maxOf(p) > 1">
      <PopoverTrigger as-child>
        <ComposerTile
          :label="p.ui.label.replace(/^reference images$/i, 'References')"
          :value="listOf(p).length ? `${listOf(p).length}/${maxOf(p)}` : `Add · 0/${maxOf(p)}`"
          :active="listOf(p).length > 0"
          :over="over === p.key"
          :title="errors[p.key] ?? p.ui.help ?? `${p.ui.label}: drop pictures here, or click to add`"
          :data-slot-key="p.key"
          data-composer-slot="images"
          @dragover="(e: DragEvent) => onDragOver(p, e)"
          @dragleave="over = undefined"
          @drop="(e: DragEvent) => onDrop(p, e)"
        >
          <template #thumb>
            <span v-if="!listOf(p).length" class="grid size-full place-items-center text-muted-foreground group-hover/tile:text-foreground"><Plus class="size-3.5" /></span>
            <span v-else class="flex size-full">
              <span v-for="id in listOf(p).slice(0, 3)" :key="id" class="h-full min-w-0 flex-1 border-r border-card last:border-0">
                <img v-if="posterOf(id)" :src="posterOf(id)" class="size-full object-cover" alt="" />
              </span>
            </span>
          </template>
        </ComposerTile>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" class="w-auto p-2.5">
        <ReferencePicker :ids="listOf(p)" :max="maxOf(p)" :label="p.ui.label" :help="p.ui.help" @update="(ids) => emit('set', p.key, ids)" />
      </PopoverContent>
    </Popover>
    <AssetSlot
      v-else
      :model-value="p.ui.control === 'images' ? listOf(p)[0] : (values[p.key] as string | undefined)"
      :kind="kindOf(p)"
      :label="p.ui.label"
      tile
      :title="errors[p.key]"
      :data-slot-key="p.key"
      @update:model-value="(v) => (p.ui.control === 'images' ? emit('set', p.key, v ? [v] : []) : emit('set', p.key, v))"
    />
  </template>
</template>
