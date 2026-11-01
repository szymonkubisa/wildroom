import type { McpIntegrationInfo } from '@shared/types/api'

/** The name Claude lists the app's tools under (`mcp__wildroom__…`). */
export const MCP_SERVER_NAME = 'wildroom'

/** A word for zsh/bash: as is when it is safe, else in single quotes. */
export function shellQuote(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`
}

/** Claude Code over HTTP: the simplest, but fixed to the port the app has now. */
export function claudeCodeHttp(info: McpIntegrationInfo): string {
  return `claude mcp add --scope user --transport http ${MCP_SERVER_NAME} ${info.url} --header ${shellQuote(`Authorization: Bearer ${info.token}`)}`
}

/** Claude Code through the stdio bridge: finds the app on any port and reads the token itself. */
export function claudeCodeStdio(info: McpIntegrationInfo): string {
  const env = Object.entries(info.bridge.env ?? {}).map(([k, v]) => `-e ${shellQuote(`${k}=${v}`)}`)
  return ['claude mcp add --scope user', MCP_SERVER_NAME, ...env, '--', ...[info.bridge.command, ...info.bridge.args].map(shellQuote)].join(' ')
}

/** Claude Desktop: `mcpServers` in claude_desktop_config.json (Settings → Developer → Edit Config). */
export function claudeDesktopConfig(info: McpIntegrationInfo): string {
  const server = { command: info.bridge.command, args: info.bridge.args, ...(info.bridge.env && Object.keys(info.bridge.env).length ? { env: info.bridge.env } : {}) }
  return JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: server } }, null, 2)
}
