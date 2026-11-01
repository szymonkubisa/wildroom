<script setup lang="ts">
import { Check, ChevronDown, LayoutDashboard, Pencil, Plus, Trash2 } from '@lucide/vue'
import { ref } from 'vue'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { useCanvasStore } from '@/stores/canvas'
import { addBoard, removeBoard, renameBoard } from './useCanvasDoc'

const canvas = useCanvasStore()
const renaming = ref(false)
const draft = ref('')

function startRename() {
  draft.value = canvas.board.name
  renaming.value = true
}

/** After the menu has closed: a dialog opened from a closing menu can leave the page unclickable. */
function openRename() {
  setTimeout(startRename)
}

function finishRename() {
  renameBoard(canvas.board.id, draft.value)
  renaming.value = false
}
</script>

<template>
  <div class="pointer-events-auto flex items-center gap-1 rounded-xl border bg-background/95 p-1 shadow-lg backdrop-blur">
    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <button class="flex h-8 max-w-56 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium hover:bg-accent">
          <LayoutDashboard class="size-4 text-muted-foreground" />
          <span class="truncate">{{ canvas.board.name }}</span>
          <ChevronDown class="size-3.5 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" class="w-60">
        <DropdownMenuItem v-for="b in canvas.boards" :key="b.id" @select="canvas.boardId = b.id">
          <Check :class="b.id === canvas.board.id ? 'opacity-100' : 'opacity-0'" />
          <span class="flex-1 truncate">{{ b.name }}</span>
          <span class="text-[10px] text-muted-foreground">{{ b.items.length }}</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem @select="addBoard()"><Plus /> New board</DropdownMenuItem>
        <DropdownMenuItem @select="openRename"><Pencil /> Rename board…</DropdownMenuItem>
        <DropdownMenuItem :disabled="canvas.boards.length <= 1" class="text-destructive focus:text-destructive" @select="removeBoard(canvas.board.id)">
          <Trash2 /> Delete board
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    <Dialog v-model:open="renaming">
      <DialogContent class="sm:max-w-sm">
        <DialogHeader><DialogTitle>Rename board</DialogTitle></DialogHeader>
        <Input v-model="draft" autofocus @keydown.enter="finishRename" />
        <DialogFooter>
          <Button variant="ghost" @click="renaming = false">Cancel</Button>
          <Button @click="finishRename">Rename</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
