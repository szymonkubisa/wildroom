import { describe, expect, it } from "vitest"
import { shortcutParts } from "./keys"

describe("shortcutParts", () => {
  it("gives every modifier its own key cap", () => {
    expect(shortcutParts("⇧⌘Z")).toEqual([{ keys: ["⇧", "⌘", "Z"] }])
    expect(shortcutParts("⌃⇧S")).toEqual([{ keys: ["⌃", "⇧", "S"] }])
    expect(shortcutParts("⌫")).toEqual([{ keys: ["⌫"] }])
  })

  it("keeps separators and named keys", () => {
    expect(shortcutParts("J / K / L")).toEqual([{ keys: ["J"] }, { sep: "/" }, { keys: ["K"] }, { sep: "/" }, { keys: ["L"] }])
    expect(shortcutParts("⇧Delete")).toEqual([{ keys: ["⇧", "Delete"] }])
    expect(shortcutParts("E W Q D")).toHaveLength(4)
  })

  it("leaves labels that are not shortcuts to be shown as text", () => {
    expect(shortcutParts("double-click")).toBeUndefined()
    expect(shortcutParts("1080×1920")).toBeUndefined()
    expect(shortcutParts("$0.04")).toBeUndefined()
    expect(shortcutParts("⌥-drag (Trim tool)")).toBeUndefined()
    expect(shortcutParts("")).toBeUndefined()
  })
})
