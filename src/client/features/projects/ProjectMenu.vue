<script setup lang="ts">
import { Copy, FolderSearch, FolderX, Pencil, Pin, PinOff, Plus, Search, Tag, Trash2 } from '@lucide/vue'
import { normalizeTag } from '@shared/projects/meta'
import type { ProjectEntry } from '@shared/types/api'
import { ref } from 'vue'
import {
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/**
 * The items of a project's ⋯ menu (its card on the grid, its row in the list): pin, rename, tags, duplicate, Finder,
 * remove from the list, Trash. `allTags`: every tag in use, to tick on or off; a new one is typed in.
 */
const props = defineProps<{ project: ProjectEntry; pinned: boolean; duplicating?: boolean; allTags: string[] }>()
const emit = defineEmits<{
  pin: []
  rename: []
  duplicate: []
  reveal: []
  locate: []
  forget: []
  trash: []
  tags: [tags: string[]]
}>()

const draft = ref('')
const has = (tag: string) => props.project.tags?.includes(tag) ?? false

function toggle(tag: string, on: boolean) {
  const tags = props.project.tags ?? []
  emit('tags', on ? [...tags, tag] : tags.filter((t) => t !== tag))
}

function addNew() {
  const tag = normalizeTag(draft.value)
  draft.value = ''
  if (tag && !has(tag)) emit('tags', [...(props.project.tags ?? []), tag])
}
</script>

<template>
  <DropdownMenuItem @select="emit('pin')">
    <component :is="pinned ? PinOff : Pin" /> {{ pinned ? 'Unpin' : 'Pin to the top' }}
  </DropdownMenuItem>
  <template v-if="project.state === 'ok'">
    <DropdownMenuItem @select="emit('rename')"><Pencil /> Rename…</DropdownMenuItem>
    <DropdownMenuSub>
      <DropdownMenuSubTrigger data-project-tags=""><Tag /> Tags</DropdownMenuSubTrigger>
      <DropdownMenuSubContent class="w-60">
        <!-- Ticking keeps the menu open, to tick several. -->
        <DropdownMenuCheckboxItem
          v-for="tag in [...new Set([...allTags, ...(project.tags ?? [])])]"
          :key="tag"
          :model-value="has(tag)"
          @select.prevent
          @update:model-value="(on) => toggle(tag, on === true)"
        >
          #{{ tag }}
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator v-if="allTags.length || project.tags?.length" />
        <!-- Keys stay in the field: the menu would read them as its type-to-find. -->
        <form class="flex items-center gap-1 p-1" @submit.prevent="addNew" @keydown.stop>
          <Input v-model="draft" placeholder="New tag, e.g. client" class="h-7 text-xs" aria-label="New tag" maxlength="40" />
          <Button type="submit" size="icon-xs" variant="outline" :disabled="!normalizeTag(draft)" aria-label="Add tag"><Plus /></Button>
        </form>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
    <DropdownMenuItem :disabled="duplicating" @select="emit('duplicate')"><Copy /> {{ duplicating ? 'Duplicating…' : 'Duplicate' }}</DropdownMenuItem>
  </template>
  <DropdownMenuItem v-if="project.state === 'missing'" @select="emit('locate')"><Search /> Locate…</DropdownMenuItem>
  <DropdownMenuItem v-else @select="emit('reveal')"><FolderSearch /> Show in Finder</DropdownMenuItem>
  <DropdownMenuItem v-if="project.recent" @select="emit('forget')"><FolderX /> Remove from list</DropdownMenuItem>
  <!-- Never for a project open on another computer: it would vanish from under it. -->
  <template v-if="project.state !== 'missing' && project.state !== 'locked'">
    <DropdownMenuSeparator />
    <DropdownMenuItem variant="destructive" @select="emit('trash')"><Trash2 /> Move to Trash…</DropdownMenuItem>
  </template>
</template>
