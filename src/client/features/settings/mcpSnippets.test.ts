import type { McpIntegrationInfo } from '@shared/types/api'
import { describe, expect, it } from 'vitest'
import { claudeCodeHttp, claudeCodeStdio, claudeDesktopConfig, shellQuote } from './mcpSnippets'

const desktop: McpIntegrationInfo = {
  enabled: true,
  url: 'http://127.0.0.1:7777/mcp',
  token: 'tok_123',
  bridge: {
    command: '/Applications/Wildroom.app/Contents/MacOS/Wildroom',
    args: ['/Applications/Wildroom.app/Contents/Resources/app.asar.unpacked/server/studio-mcp.mjs'],
    env: { ELECTRON_RUN_AS_NODE: '1', STUDIO_APP_DATA: '/Users/me/Library/Application Support/Wildroom' },
  },
  appDataDir: '/Users/me/Library/Application Support/Wildroom',
}

describe('MCP snippets', () => {
  it('quotes only what the shell would split', () => {
    expect(shellQuote('/usr/bin/node')).toBe('/usr/bin/node')
    expect(shellQuote('/A B/c')).toBe(`'/A B/c'`)
    expect(shellQuote(`it's`)).toBe(`'it'\\''s'`)
  })

  it('writes the Claude Code commands', () => {
    expect(claudeCodeHttp(desktop)).toBe(`claude mcp add --scope user --transport http wildroom http://127.0.0.1:7777/mcp --header 'Authorization: Bearer tok_123'`)
    expect(claudeCodeStdio(desktop)).toBe(
      `claude mcp add --scope user wildroom -e ELECTRON_RUN_AS_NODE=1 -e 'STUDIO_APP_DATA=/Users/me/Library/Application Support/Wildroom' -- ` +
        `/Applications/Wildroom.app/Contents/MacOS/Wildroom /Applications/Wildroom.app/Contents/Resources/app.asar.unpacked/server/studio-mcp.mjs`,
    )
  })

  it('writes Claude Desktop’s config', () => {
    expect(JSON.parse(claudeDesktopConfig(desktop))).toEqual({ mcpServers: { 'wildroom': { command: desktop.bridge.command, args: desktop.bridge.args, env: desktop.bridge.env } } })
  })
})
