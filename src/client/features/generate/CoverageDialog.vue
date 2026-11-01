<script setup lang="ts">
import { computed, ref } from 'vue'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { CoverageAngle } from './coverage'
import CoveragePicker from './CoveragePicker.vue'
import { coverageCostEach, coverageFor, coverageModel, runCoverage } from './coverageRun'

/** Create's "Shots" on an image: the coverage picker in a dialog (openCoverage), the pictures beside it on the board. */
const busy = ref(false)
const target = computed(() => coverageFor.value)
const model = computed(() => (target.value ? coverageModel() : undefined))
const costEach = computed(() => (target.value ? coverageCostEach(model.value, target.value.asset) : undefined))
const blocker = computed(() => (target.value && !model.value ? 'No image model that takes a reference picture is ready — add a key in Settings' : undefined))

async function make(angles: CoverageAngle[]) {
  const t = target.value
  if (!t) return
  busy.value = true
  try {
    if (await runCoverage(t.asset, angles, t.item)) coverageFor.value = undefined
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Dialog :open="Boolean(target)" @update:open="(v) => !v && (coverageFor = undefined)">
    <DialogContent class="sm:max-w-md" data-coverage-dialog="">
      <DialogHeader>
        <DialogTitle>Shots from this image</DialogTitle>
        <DialogDescription>{{ model ? `Drawn by ${model.label}, one picture per angle.` : 'More shots of the same moment.' }}</DialogDescription>
      </DialogHeader>
      <CoveragePicker
        v-if="target"
        :src="`/media/${target.asset.id}/${target.asset.variants.display ? 'display' : 'poster'}`"
        :cost-each="costEach"
        :blocker="blocker"
        :busy="busy"
        :what="target.item ? 'they land beside it on the board' : 'they land in the Feed'"
        @make="make"
      />
    </DialogContent>
  </Dialog>
</template>
