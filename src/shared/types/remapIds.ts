/**
 * Deep copy of `value` with exact string values and object keys found in `map` replaced — how a project copy's
 * documents follow its new asset and generation ids. Substrings are never touched, so ids embedded in other text
 * (or external ids such as provider task or voice ids) stay as they are.
 */
export function remapIds<T>(value: T, map: Readonly<Record<string, string>>): T {
  return remap(value, map) as T
}

function remap(value: unknown, map: Readonly<Record<string, string>>): unknown {
  if (typeof value === 'string') return Object.hasOwn(map, value) ? map[value] : value
  if (Array.isArray(value)) return value.map((v) => remap(v, map))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[Object.hasOwn(map, k) ? map[k]! : k] = remap(v, map)
    return out
  }
  return value
}
