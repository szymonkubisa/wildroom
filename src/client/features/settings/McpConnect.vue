<script setup lang="ts">
import { Check, Copy, Eye, EyeOff, RefreshCw } from '@lucide/vue'
import type { McpIntegrationInfo } from '@shared/types/api'
import { computed, onMounted, ref } from 'vue'
import { toast } from 'vue-sonner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { api, errorMessage } from '@/lib/api'
import { claudeCodeHttp, claudeCodeStdio, claudeDesktopConfig } from './mcpSnippets'

/**
 * Settings → Integrations: how to connect Claude Code or Claude Desktop to this app over MCP — the endpoint, the
 * install's token (hidden until asked) and copy-ready setup snippets with it filled in.
 */
const info = ref<McpIntegrationInfo>()
const loadError = ref<string>()
const reveal = ref(false)
const copied = ref<string>()
const confirmRenew = ref(false)

async function load() {
  try {
    info.value = await api.integrations.mcp()
    loadError.value = undefined
  } catch (err) {
    loadError.value = errorMessage(err)
  }
}
onMounted(load)

const MASK = '••••••••••••'
const hide = (text: string) => (reveal.value || !info.value ? text : text.split(info.value.token).join(MASK))

const snippets = computed(() => {
  const i = info.value
  if (!i) return []
  return [
    { id: 'code-stdio', title: 'Claude Code', note: 'Recommended: finds the app on any port and reads the token itself. Run once in Terminal.', text: claudeCodeStdio(i) },
    { id: 'code-http', title: 'Claude Code over HTTP', note: 'Straight to the endpoint, with the token. Stops working if the app moves to another port.', text: claudeCodeHttp(i) },
    { id: 'desktop', title: 'Claude Desktop', note: 'Settings → Developer → Edit Config: merge into claude_desktop_config.json, then restart Claude.', text: claudeDesktopConfig(i) },
  ]
})

async function copy(id: string, text: string) {
  try {
    await navigator.clipboard.writeText(text)
    copied.value = id
    setTimeout(() => copied.value === id && (copied.value = undefined), 1500)
  } catch (err) {
    toast.error('Could not copy', { description: errorMessage(err) })
  }
}

async function renew() {
  try {
    info.value = await api.integrations.renewMcpToken()
    toast.success('New token made', { description: 'Set up Claude again with the new snippet (the stdio bridge picks it up by itself).' })
  } catch (err) {
    toast.error('Could not make a new token', { description: errorMessage(err) })
  }
}
</script>

<template>
  <div class="grid w-full min-w-0 gap-3" data-mcp-connect="">
    <p v-if="loadError" class="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{{ loadError }}</p>
    <template v-else-if="info">
      <div class="grid gap-1.5 rounded-lg bg-muted/50 px-3 py-2 text-xs">
        <div class="flex min-w-0 items-center gap-2">
          <span class="w-16 shrink-0 text-muted-foreground">Endpoint</span>
          <span class="min-w-0 flex-1 truncate font-mono" :title="info.url">{{ info.url }}</span>
          <Button variant="ghost" size="icon-sm" aria-label="Copy the endpoint" @click="copy('url', info.url)">
            <Check v-if="copied === 'url'" /><Copy v-else />
          </Button>
        </div>
        <div class="flex min-w-0 items-center gap-2">
          <span class="w-16 shrink-0 text-muted-foreground">Token</span>
          <span class="min-w-0 flex-1 truncate font-mono" data-mcp-token="">{{ reveal ? info.token : MASK }}</span>
          <Button variant="ghost" size="icon-sm" :aria-label="reveal ? 'Hide the token' : 'Show the token'" @click="reveal = !reveal">
            <EyeOff v-if="reveal" /><Eye v-else />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Copy the token" @click="copy('token', info.token)">
            <Check v-if="copied === 'token'" /><Copy v-else />
          </Button>
          <Button variant="ghost" size="sm" class="text-xs" @click="confirmRenew = true"><RefreshCw /> New token</Button>
        </div>
      </div>

      <div v-for="s in snippets" :key="s.id" class="grid gap-1" :data-mcp-snippet="s.id">
        <div class="flex items-center gap-2">
          <span class="text-xs font-medium">{{ s.title }}</span>
          <Button variant="outline" size="sm" class="ml-auto h-6 px-2 text-[11px]" @click="copy(s.id, s.text)">
            <Check v-if="copied === s.id" /><Copy v-else /> {{ copied === s.id ? 'Copied' : 'Copy' }}
          </Button>
        </div>
        <pre class="max-h-48 overflow-auto rounded-lg bg-muted/60 px-3 py-2 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap">{{ hide(s.text) }}</pre>
        <p class="text-[11px] leading-snug text-muted-foreground">{{ s.note }}</p>
      </div>

      <p class="text-[11px] leading-snug text-muted-foreground">
        Then ask Claude to, say, “make a 30-second explainer about … in Wildroom”. Paid renders always come back to you with their price first.
        Details: docs/mcp.md.
      </p>
    </template>

    <AlertDialog v-model:open="confirmRenew">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Make a new token?</AlertDialogTitle>
          <AlertDialogDescription>
            Claude set up with the old token (over HTTP, or in a config with it written in) stops reaching the app until you set it up again.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction @click="renew">New token</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>
