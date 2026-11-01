<script setup lang="ts">
import { Search } from '@lucide/vue'
import { useLocalStorage } from '@vueuse/core'
import { computed, ref } from 'vue'
import { cn } from '@/lib/utils'
import { type Recipe, RECIPES, applyRecipe } from './recipes'
import RecipePreview from './RecipePreview.vue'

/**
 * The recipes as a catalog: cards with a miniature that plays on hover, by group, with a chip per group and a search
 * — the empty Feed shows it, and Recipes in Create's bar. `columns`: how many cards a row (the popover has three).
 */
const props = withDefaults(defineProps<{ columns?: number }>(), { columns: 4 })
const emit = defineEmits<{ picked: [recipe: Recipe] }>()

const GROUPS = [...new Set(RECIPES.map((r) => r.group))]
/** The group chip last picked (kept across reloads); none is All. */
const only = useLocalStorage<Recipe['group'] | null>('recipes.group', null)
if (only.value && !GROUPS.includes(only.value)) only.value = null
const query = ref('')
const shown = computed(() => {
  const q = query.value.trim().toLowerCase()
  return RECIPES.filter((r) => (!only.value || r.group === only.value) && (!q || [r.title, r.sub, r.prompt, r.group].some((t) => t?.toLowerCase().includes(q))))
})

const groups = computed(() => {
  const out: { group: string; items: Recipe[] }[] = []
  for (const r of shown.value) {
    const g = out.find((x) => x.group === r.group)
    if (g) g.items.push(r)
    else out.push({ group: r.group, items: [r] })
  }
  return out
})

function pick(r: Recipe) {
  applyRecipe(r)
  emit('picked', r)
}
</script>

<template>
  <div class="grid gap-4 text-left" data-recipe-catalog="">
    <div class="flex flex-wrap items-center gap-1">
      <button
        v-for="g in [null, ...GROUPS]"
        :key="g ?? 'all'"
        type="button"
        :class="cn('h-7 rounded-full px-3 text-xs font-medium transition-colors', only === g ? 'bg-brand text-white' : 'bg-field text-muted-foreground hover:bg-field-hover hover:text-foreground')"
        :data-recipe-group="g ?? 'all'"
        @click="only = g"
      >
        {{ g ?? 'All' }}
      </button>
      <label class="ml-auto flex h-7 w-44 items-center gap-1.5 rounded-full bg-field px-2.5 text-xs">
        <Search class="size-3.5 shrink-0 text-muted-foreground" />
        <input v-model="query" type="search" placeholder="Search recipes" class="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground" data-recipe-search="" />
      </label>
    </div>
    <p v-if="!groups.length" class="py-6 text-center text-xs text-muted-foreground">No recipe matches.</p>
    <section v-for="g in groups" :key="g.group" class="grid gap-2">
      <h4 class="font-mono text-[10px] font-medium tracking-widest text-muted-foreground uppercase">{{ g.group }}</h4>
      <div class="grid gap-2" :style="{ gridTemplateColumns: `repeat(${props.columns}, minmax(0, 1fr))` }">
        <button
          v-for="r in g.items"
          :key="r.id"
          type="button"
          class="recipe-card group/recipe grid content-start gap-2 rounded-xl border bg-card p-1.5 pb-2.5 text-left transition-[transform,border-color,box-shadow] hover:-translate-y-0.5 hover:border-brand/50 hover:shadow-[0_12px_30px_-14px_var(--brand)]"
          :title="r.prompt ?? r.sub"
          :data-recipe="r.id"
          @click="pick(r)"
        >
          <span class="relative block aspect-video overflow-hidden rounded-lg">
            <RecipePreview :id="r.id" />
            <span class="absolute bottom-1 left-1 grid size-6 place-items-center rounded-md bg-black/55 text-white backdrop-blur-sm transition-colors group-hover/recipe:bg-brand">
              <component :is="r.icon" class="size-3.5" />
            </span>
          </span>
          <span class="grid gap-0.5 px-1">
            <span class="text-[13px] font-medium">{{ r.title }}</span>
            <span class="text-[11px] leading-snug text-muted-foreground">{{ r.sub }}</span>
          </span>
        </button>
      </div>
    </section>
  </div>
</template>
