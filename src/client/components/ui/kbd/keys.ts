import { Comment, Fragment, Text, type VNode } from "vue"

/** Modifier glyphs: each one gets a key cap of its own. */
const MODIFIERS = new Set(["⌘", "⌃", "⌥", "⇧"])
/** Named keys that read as one cap. */
const NAMED = /^(Space|Tab|Esc|Enter|Return|Delete|Home|End|PgUp|PgDn|fn)$/i

export type ShortcutPart = { keys: string[] } | { sep: string }

/**
 * Splits a shortcut label into key caps: "⇧⌘Z" → [⇧][⌘][Z], "J / K / L" → [J] / [K] / [L].
 * Returns undefined when the label is not a plain shortcut ("double-click", "1080×1920", a price,
 * "⌥-drag (Trim tool)"), so callers can render it as text instead.
 */
export function shortcutParts(label: string): ShortcutPart[] | undefined {
  const tokens = label.trim().split(/\s+/).filter(Boolean)
  if (!tokens.length) return undefined
  const parts: ShortcutPart[] = []
  for (const token of tokens) {
    if (token === "/" || token === "+") {
      parts.push({ sep: token })
      continue
    }
    const chars = [...token]
    const keys: string[] = []
    let i = 0
    while (i < chars.length && MODIFIERS.has(chars[i]!)) keys.push(chars[i++]!)
    const rest = chars.slice(i).join("")
    if (rest) {
      const single = [...rest].length === 1
      if (!single && !NAMED.test(rest)) return undefined
      keys.push(single ? rest.toUpperCase() : rest)
    }
    parts.push({ keys })
  }
  return parts
}

/** The plain text of a slot, or undefined when it holds anything but text (icons, elements). */
export function slotText(nodes: VNode[] | undefined): string | undefined {
  let out = ""
  for (const node of nodes ?? []) {
    if (node.type === Comment) continue
    if (node.type === Text) out += String(node.children ?? "")
    else if (node.type === Fragment && Array.isArray(node.children)) {
      const inner = slotText(node.children as VNode[])
      if (inner === undefined) return undefined
      out += inner
    }
    else return undefined
  }
  return out
}
