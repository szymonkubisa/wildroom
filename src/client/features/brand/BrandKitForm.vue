<script setup lang="ts">
import { Droplets, LayoutDashboard, Plus, Sparkles, Trash2, Wand2 } from '@lucide/vue'
import { COLOR_ROLES, type ColorRole, FONT_ROLES, type FontRole, brandPromptSuffix, emptyBrand, hasBrand } from '@shared/types/brand'
import { storeToRefs } from 'pinia'
import { computed, ref } from 'vue'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import AssetSlot from '@/features/generate/AssetSlot.vue'
import { TITLE_FONTS } from '@/engine/titles'
import { errorMessage } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useAssetsStore } from '@/stores/assets'
import { useCanvasStore } from '@/stores/canvas'
import { useEditorStore } from '@/stores/editor'
import { useProjectStore } from '@/stores/project'
import { createBrandBoard, editBrand, generateLogos } from './brandActions'
import { useBrandSwitch } from './brandSwitch'
import { luminance, paletteOfAsset } from './palette'

/**
 * The project's brand kit (ProjectDoc.brand) in one narrow column — Library › Brand. On top, the switch Generate
 * follows: with it on, image and video prompts get the kit's style and palette and its style images as references.
 */
const project = useProjectStore()
const assets = useAssetsStore()
const editor = useEditorStore()
const canvas = useCanvasStore()
const { on: brandOn } = storeToRefs(useBrandSwitch())

const brand = computed(() => project.doc.brand ?? emptyBrand())
const filled = computed(() => hasBrand(project.doc.brand))
const logo = computed(() => assets.get(brand.value.logoAssetIds[0]))
const FONT_SUGGESTIONS = ['Inter', 'Helvetica Neue', 'SF Pro Display', 'Avenir Next', 'Futura', 'Georgia', 'Didot', 'Playfair Display', 'Montserrat', 'Lora', ...TITLE_FONTS]

function setField(key: 'name' | 'tagline' | 'description' | 'styleText' | 'avoidText' | 'tone', value: string, label: string) {
  if (brand.value[key] === value) return
  editBrand(label, (b) => (b[key] = value))
}

// ---- colours
function addColor() {
  editBrand('Add colour', (b) => b.colors.push({ hex: '#7c3aed', role: b.colors.length ? undefined : 'primary' }))
}
function setColor(i: number, patch: { hex?: string; name?: string; role?: ColorRole | undefined }) {
  editBrand('Change colour', (b) => {
    const c = b.colors[i]
    if (!c) return
    if (patch.hex) c.hex = patch.hex.toLowerCase()
    if (patch.name !== undefined) c.name = patch.name || undefined
    if ('role' in patch) {
      // One colour per role.
      if (patch.role) for (const other of b.colors) if (other !== c && other.role === patch.role) delete other.role
      if (patch.role) c.role = patch.role
      else delete c.role
    }
  })
}
function removeColor(i: number) {
  editBrand('Remove colour', (b) => b.colors.splice(i, 1))
}

const extracting = ref(false)
/** The picker is an action, not a setting: it shows its placeholder again after each extraction. */
const paletteChoice = ref<string>()
/** Images the palette can come from: logos first, then style references. */
const paletteSources = computed(() => [...brand.value.logoAssetIds, ...brand.value.refAssetIds].map((id) => assets.get(id)).filter((a) => a?.kind === 'image'))
async function extractFrom(assetId: string) {
  const a = assets.get(assetId)
  if (!a) return
  extracting.value = true
  try {
    const palette = (await paletteOfAsset(a, 6)).filter((c) => c.share >= 0.02)
    if (!palette.length) return toast('No solid colours found in that image')
    editBrand('Palette from image', (b) => {
      const known = new Set(b.colors.map((c) => c.hex))
      for (const c of palette) if (!known.has(c.hex)) b.colors.push({ hex: c.hex, ...(b.colors.length ? {} : { role: 'primary' as const }) })
    })
    toast.success(`Added ${palette.length} colours from “${a.name}”`, { description: 'Name them and give them roles — the strongest ones first.' })
  } catch (err) {
    toast.error('Could not read the colours', { description: errorMessage(err) })
  } finally {
    extracting.value = false
    paletteChoice.value = undefined
  }
}

// ---- fonts
function setFont(role: FontRole, family: string) {
  editBrand('Font', (b) => {
    const clean = family.trim()
    const existing = b.fonts.find((f) => f.role === role)
    if (!clean) b.fonts = b.fonts.filter((f) => f.role !== role)
    else if (existing) existing.family = clean
    else b.fonts.push({ family: clean, role })
  })
}
const fontOf = (role: FontRole) => brand.value.fonts.find((f) => f.role === role)?.family ?? ''

// ---- logos & references (asset id lists)
function setListItem(list: 'logoAssetIds' | 'refAssetIds', i: number, id: string | undefined) {
  editBrand(list === 'logoAssetIds' ? 'Logo' : 'Style reference', (b) => {
    if (id) {
      if (i < b[list].length) b[list][i] = id
      else b[list].push(id)
      b[list] = [...new Set(b[list])]
    } else b[list].splice(i, 1)
  })
}

const suffix = computed(() => brandPromptSuffix(brand.value))

function planAssets() {
  editor.workspace = 'canvas'
  canvas.dialog = 'asset-set'
}

const section = 'grid gap-2.5 rounded-xl border bg-card/60 p-3'
const heading = 'text-[11px] font-medium tracking-wide text-muted-foreground uppercase'
</script>

<template>
  <ScrollArea class="h-full" data-tour="brand">
    <div class="grid gap-3 p-3" data-brand-kit="">
      <!-- The switch Generate follows (its "Brand" row is the same one). -->
      <label class="grid cursor-pointer gap-1 rounded-xl border border-brand/30 bg-brand/5 p-3" data-brand-switch="">
        <span class="flex items-center gap-2.5 text-sm font-medium">
          <Switch v-model="brandOn" aria-label="Use the look in every generation" />
          Use the look in every generation
        </span>
        <span class="text-[11px] leading-snug text-muted-foreground">
          <template v-if="filled">Generate adds the style and palette below to image and video prompts, and the style images as references. Plan’s shot stills and takes don’t use it.</template>
          <template v-else>Fill in the kit below — a style, a palette or a style image — and Generate follows it.</template>
        </span>
      </label>

      <!-- Identity -->
      <div class="flex items-center gap-3">
        <div class="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-xl border bg-background">
          <img v-if="logo" :src="`/media/${logo.id}/${logo.variants.display ? 'display' : 'original'}`" class="size-full object-contain" alt="" />
          <Droplets v-else class="size-5 text-muted-foreground" />
        </div>
        <div class="grid min-w-0 flex-1 gap-0.5">
          <Input
            :model-value="brand.name"
            placeholder="Brand name"
            class="h-8 border-0 bg-transparent px-0 text-lg font-semibold shadow-none focus-visible:ring-0"
            data-brand-name=""
            @change="(e: Event) => setField('name', (e.target as HTMLInputElement).value, 'Name')"
          />
          <Input
            :model-value="brand.tagline"
            placeholder="Tagline"
            class="h-7 border-0 bg-transparent px-0 text-xs text-muted-foreground shadow-none focus-visible:ring-0"
            @change="(e: Event) => setField('tagline', (e.target as HTMLInputElement).value, 'Tagline')"
          />
        </div>
      </div>
      <div class="grid grid-cols-2 gap-1.5">
        <Button size="sm" class="bg-brand text-brand-foreground hover:bg-brand/90" @click="planAssets"><Sparkles /> Plan assets</Button>
        <Button size="sm" variant="outline" @click="createBrandBoard(brand)"><LayoutDashboard /> Brand board</Button>
      </div>

      <section :class="section">
        <h2 :class="heading">About</h2>
        <Textarea
          :model-value="brand.description"
          rows="3"
          placeholder="What the brand does and who it's for — e.g. “Small-batch coffee roastery in Leeds for people who care where their beans come from.”"
          class="text-xs"
          @change="(e: Event) => setField('description', (e.target as HTMLTextAreaElement).value, 'Description')"
        />
        <label class="grid gap-1 text-xs">
          <span class="text-muted-foreground">Voice & tone (for copy in banners and posts)</span>
          <Input :model-value="brand.tone" placeholder="Warm, direct, a little playful" class="h-8 text-xs" @change="(e: Event) => setField('tone', (e.target as HTMLInputElement).value, 'Tone')" />
        </label>
      </section>

      <!-- Colours -->
      <section :class="section">
        <div class="flex items-center gap-2">
          <h2 :class="cn(heading, 'flex-1')">Palette</h2>
          <Button size="xs" variant="outline" @click="addColor"><Plus /> Colour</Button>
        </div>
        <Select v-if="paletteSources.length" :model-value="paletteChoice" :disabled="extracting" @update:model-value="(v) => extractFrom(String(v))">
          <SelectTrigger class="h-7 w-full gap-1.5 text-xs"><Droplets class="size-3.5" /><SelectValue placeholder="Extract from a logo or style image" /></SelectTrigger>
          <SelectContent>
            <SelectItem v-for="a in paletteSources" :key="a!.id" :value="a!.id">{{ a!.name }}</SelectItem>
          </SelectContent>
        </Select>
        <p v-if="!brand.colors.length" class="text-[11px] text-muted-foreground">Add colours by hand, or add a logo / style image below and extract its palette.</p>
        <div class="grid grid-cols-2 gap-2">
          <div v-for="(c, i) in brand.colors" :key="i" class="group overflow-hidden rounded-lg border bg-background">
            <label class="relative block h-12 cursor-pointer" :style="{ background: c.hex }">
              <input type="color" :value="c.hex" class="absolute inset-0 cursor-pointer opacity-0" @change="(e) => setColor(i, { hex: (e.target as HTMLInputElement).value })" />
              <span class="absolute bottom-1 left-1.5 font-mono text-[10px]" :style="{ color: luminance(c.hex) > 0.45 ? '#111' : '#fff' }">{{ c.hex.toUpperCase() }}</span>
              <button class="absolute top-1 right-1 rounded bg-black/40 p-0.5 text-white opacity-0 group-hover:opacity-100 focus-visible:opacity-100" title="Remove" @click.prevent="removeColor(i)">
                <Trash2 class="size-3" />
              </button>
            </label>
            <div class="grid gap-1 p-1.5">
              <Input :model-value="c.name ?? ''" placeholder="Name" class="h-7 text-xs" @change="(e: Event) => setColor(i, { name: (e.target as HTMLInputElement).value })" />
              <Select :model-value="c.role ?? 'none'" @update:model-value="(v) => setColor(i, { role: v === 'none' ? undefined : (v as ColorRole) })">
                <SelectTrigger class="h-7 w-full text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No role</SelectItem>
                  <SelectItem v-for="r in COLOR_ROLES" :key="r" :value="r" class="capitalize">{{ r }}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
      </section>

      <!-- Type -->
      <section :class="section">
        <h2 :class="heading">Titles & type</h2>
        <datalist id="brand-fonts">
          <option v-for="f in FONT_SUGGESTIONS" :key="f" :value="f" />
        </datalist>
        <label v-for="role in FONT_ROLES" :key="role" class="grid gap-1 text-xs">
          <span class="text-muted-foreground capitalize">{{ role }}</span>
          <Input :model-value="fontOf(role)" list="brand-fonts" placeholder="Font family" class="h-8 text-xs" @change="(e: Event) => setFont(role, (e.target as HTMLInputElement).value)" />
          <span v-if="fontOf(role)" class="truncate text-xl leading-tight" :style="{ fontFamily: `'${fontOf(role)}', Inter, sans-serif`, fontWeight: role === 'heading' ? 700 : 400 }">Aa Bb 123</span>
        </label>
        <p class="text-[11px] text-muted-foreground">Fonts installed on this Mac preview here and are used for text on the board and in exports.</p>
      </section>

      <!-- Logos -->
      <section :class="section">
        <div class="flex items-center gap-2">
          <h2 :class="cn(heading, 'flex-1')">Logos</h2>
          <Button size="xs" variant="outline" @click="generateLogos(brand)"><Wand2 /> Logo ideas</Button>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <AssetSlot
            v-for="(id, i) in [...brand.logoAssetIds, undefined]"
            :key="`logo-${i}-${id ?? 'new'}`"
            kind="image"
            :label="i === 0 ? 'Primary logo' : id ? `Variant ${i}` : 'Add a variant'"
            :model-value="id"
            compact
            @update:model-value="(v) => setListItem('logoAssetIds', i, v)"
          />
        </div>
      </section>

      <!-- Style -->
      <section :class="section">
        <h2 :class="heading">Style</h2>
        <Textarea
          :model-value="brand.styleText"
          rows="2"
          placeholder="Flat illustration, warm daylight, lots of white space, soft paper texture"
          class="text-xs"
          data-brand-style=""
          @change="(e: Event) => setField('styleText', (e.target as HTMLTextAreaElement).value, 'Style')"
        />
        <label class="grid gap-1 text-xs">
          <span class="text-muted-foreground">Avoid</span>
          <Input :model-value="brand.avoidText" placeholder="Gradients, stock-photo people, neon" class="h-8 text-xs" @change="(e: Event) => setField('avoidText', (e.target as HTMLInputElement).value, 'Avoid')" />
        </label>
        <div class="grid gap-1.5">
          <span class="text-[11px] text-muted-foreground">Style references — images that show the look (references in the Composer while the switch above is on)</span>
          <div class="grid grid-cols-2 gap-2">
            <AssetSlot
              v-for="(id, i) in [...brand.refAssetIds, undefined]"
              :key="`ref-${i}-${id ?? 'new'}`"
              kind="image"
              :label="id ? `Reference ${i + 1}` : 'Add a reference'"
              :model-value="id"
              compact
              @update:model-value="(v) => setListItem('refAssetIds', i, v)"
            />
          </div>
        </div>
        <div v-if="suffix" class="rounded-md border border-dashed bg-background/60 p-2 text-[11px] leading-relaxed text-muted-foreground">
          <span class="font-medium text-foreground">{{ brandOn ? 'Added to prompts:' : 'Added to prompts when the switch is on:' }}</span> {{ suffix }}
        </div>
      </section>
    </div>
  </ScrollArea>
</template>
