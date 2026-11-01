<script setup lang="ts">
import { AlertTriangle, CheckCircle2, Crosshair, Loader2, ScanSearch, Wand2 } from '@lucide/vue'
import { getModel } from '@shared/models/registry'
import { type Clip, activeTake } from '@shared/types/project-doc'
import { computed, ref, watch } from 'vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { transport } from '@/features/editor/transport'
import { type ContinuityCut, type ContinuityIssue, api, errorMessage } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useAssetsStore } from '@/stores/assets'
import { useEditorStore } from '@/stores/editor'
import { useGenerateStore } from '@/stores/generate'
import { useProjectStore } from '@/stores/project'
import { useClipTools } from './useClipTools'

const open = defineModel<boolean>('open', { default: false })
const project = useProjectStore()
const assets = useAssetsStore()
const editor = useEditorStore()
const clipTools = useClipTools()

interface Cut {
  cut: number
  frame: number
  outgoingId: string
  incomingId: string
  label: string
  request: ContinuityCut
}

function pictureAsset(clip: Clip) {
  if (clip.kind !== 'media' || !clip.video) return undefined
  const a = assets.get(activeTake(clip)?.assetId)
  return a && a.kind !== 'audio' ? a : undefined
}

/** Every cut between two picture clips on the primary storyline. */
const cuts = computed<Cut[]>(() => {
  const spine = project.layout.spine
  const out: Cut[] = []
  for (let i = 1; i < spine.length; i++) {
    const a = spine[i - 1]!
    const b = spine[i]!
    const aa = pictureAsset(a.item)
    const ba = pictureAsset(b.item)
    if (!aa || !ba || a.item.kind !== 'media' || b.item.kind !== 'media') continue
    const n = out.length + 1
    const label = `${a.item.name ?? aa.name} → ${b.item.name ?? ba.name}`
    out.push({
      cut: n,
      frame: b.start,
      outgoingId: a.id,
      incomingId: b.id,
      label,
      request: {
        cut: n,
        label,
        outgoing: { assetId: aa.id, seconds: aa.kind === 'image' ? 0 : clipTools.sourceSecondsAt(a.item, a.end - a.overlapOut - 1) },
        incoming: { assetId: ba.id, seconds: ba.kind === 'image' ? 0 : clipTools.sourceSecondsAt(b.item, b.start) },
        prompt: ba.generation?.prompt,
      },
    })
  }
  return out
})

const running = ref(false)
const error = ref<string>()
const issues = ref<ContinuityIssue[]>()
const via = ref<string>()

async function run() {
  if (!cuts.value.length) return
  running.value = true
  error.value = undefined
  try {
    const res = await api.analysis.continuity(cuts.value.map((c) => c.request))
    issues.value = res.issues.sort((x, y) => x.cut - y.cut)
    via.value = res.via
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    running.value = false
  }
}

watch(open, (v) => {
  if (v && !running.value) void run()
})

function cutOf(issue: ContinuityIssue) {
  return cuts.value.find((c) => c.cut === issue.cut)
}

function jump(issue: ContinuityIssue) {
  const c = cutOf(issue)
  if (!c) return
  transport.seek(c.frame)
  editor.select([c.incomingId])
}

/** Opens the Composer for a new take of the incoming shot, with the fix appended to its prompt. */
function regenerate(issue: ContinuityIssue) {
  const c = cutOf(issue)
  const clip = c && project.doc.spine.find((s) => s.id === c.incomingId)
  if (!clip || clip.kind !== 'media') return
  const gen = assets.get(activeTake(clip)?.assetId)?.generation
  const model = gen ? getModel(gen.modelId) : undefined
  const prompt = [String(gen?.params.prompt ?? gen?.prompt ?? '').trim(), issue.fix].filter(Boolean).join(' ')
  useGenerateStore().open(model?.kind ?? 'video', {
    modelId: model?.id,
    params: { ...(gen?.params ?? {}), prompt },
    target: { clipId: clip.id, label: `New take of the shot after cut ${issue.cut}, with the continuity fix` },
  })
  editor.select([clip.id])
  open.value = false
}

const severityClass = (s: ContinuityIssue['severity']) =>
  s === 'high' ? 'bg-destructive/20 text-destructive' : s === 'medium' ? 'bg-role-effects/20 text-role-effects' : 'bg-muted text-muted-foreground'
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-xl">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2"><ScanSearch class="size-4" /> Continuity check</DialogTitle>
        <DialogDescription>
          Compares the frames on both sides of every cut for character, wardrobe, prop, lighting and colour changes.
        </DialogDescription>
      </DialogHeader>

      <div v-if="!cuts.length" class="py-6 text-center text-sm text-muted-foreground">There are no cuts between picture clips on the primary storyline yet.</div>
      <div v-else-if="running" class="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
        <Loader2 class="size-4 animate-spin" /> Checking {{ cuts.length }} cut{{ cuts.length === 1 ? '' : 's' }}…
      </div>
      <div v-else-if="error" class="grid gap-3 py-4 text-sm">
        <p class="text-destructive">{{ error }}</p>
        <Button variant="outline" class="justify-self-start" @click="run">Try again</Button>
      </div>
      <template v-else-if="issues">
        <div v-if="!issues.length" class="flex flex-col items-center gap-2 py-8 text-sm">
          <CheckCircle2 class="size-6 text-role-music" />
          No continuity problems found across {{ cuts.length }} cut{{ cuts.length === 1 ? '' : 's' }}.
        </div>
        <ScrollArea v-else class="max-h-[55vh]">
          <div class="grid gap-2 pr-3">
            <div v-for="(issue, i) in issues" :key="i" class="grid gap-1.5 rounded-md border bg-card p-2.5">
              <div class="flex items-center gap-2 text-xs">
                <AlertTriangle class="size-3.5 shrink-0 text-role-effects" />
                <span class="font-medium">Cut {{ issue.cut }}</span>
                <span class="min-w-0 flex-1 truncate text-muted-foreground">{{ cutOf(issue)?.label }}</span>
                <Badge variant="secondary" :class="cn('text-[10px] capitalize', severityClass(issue.severity))">{{ issue.severity }}</Badge>
                <Badge variant="outline" class="text-[10px] capitalize">{{ issue.category }}</Badge>
              </div>
              <p class="text-sm">{{ issue.note }}</p>
              <p v-if="issue.fix" class="rounded bg-muted/60 px-2 py-1 text-xs text-muted-foreground">Fix: {{ issue.fix }}</p>
              <div class="flex gap-1.5">
                <Button size="xs" variant="outline" @click="jump(issue)"><Crosshair /> Go to cut</Button>
                <Button size="xs" variant="outline" @click="regenerate(issue)"><Wand2 /> Regenerate with fix…</Button>
              </div>
            </div>
          </div>
        </ScrollArea>
        <div class="flex items-center justify-between text-[11px] text-muted-foreground">
          <span>{{ via === 'claude' ? 'Checked by Claude (vision)' : 'Demo mode: brightness and colour only — add an Anthropic key for a full check' }}</span>
          <Button size="xs" variant="ghost" @click="run">Run again</Button>
        </div>
      </template>
    </DialogContent>
  </Dialog>
</template>
