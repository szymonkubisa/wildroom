import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { nanoid } from 'nanoid'
import type { TempVoiceInfo } from '../../shared/types/api'
import { ApiError, badRequest } from '../http'
import { cachedList } from './cachedList'
import { runFfmpeg } from './ffmpeg'
import { looksPolish, speakableText } from './speechText'

/**
 * Temporary voices for animatics: macOS speech (`say`), free and offline, so timing can be judged before paying for
 * ElevenLabs. Not for final audio.
 */

const SAY = '/usr/bin/say'
const MAX_CHARS = 4000
/** The stock Polish voice; any other installed pl_* voice is the fallback. */
const PREFERRED_POLISH = ['Zosia']

const run = promisify(execFile)

export function sayAvailable(platform: NodeJS.Platform = process.platform, exists: (path: string) => boolean = existsSync): boolean {
  return platform === 'darwin' && exists(SAY)
}

function assertSay() {
  if (!sayAvailable()) throw new ApiError(501, 'Temporary voices use macOS speech (the say command), which is not available on this machine')
}

/** `say -v '?'` lines look like "Daniel (English (UK)) en_GB    # Hello! My name is Daniel." — names may have spaces. */
export function parseSayVoices(out: string): TempVoiceInfo[] {
  const voices: TempVoiceInfo[] = []
  const seen = new Set<string>()
  for (const line of out.split('\n')) {
    const m = /^(.+?)\s+([a-z]{2,3}_[A-Za-z0-9]+)\s+#/.exec(line)
    const name = m?.[1]!.trim()
    // macOS lists some voices twice (several qualities installed).
    if (!m || !name || seen.has(name)) continue
    seen.add(name)
    voices.push({ name, locale: m[2]! })
  }
  return voices
}

const voiceList = cachedList<TempVoiceInfo>(10 * 60_000)

/** Installed voices (cached for 10 minutes; new voices come from System Settings → Accessibility → Spoken Content). */
export function listSayVoices(): Promise<TempVoiceInfo[]> {
  assertSay()
  return voiceList.get(async () => parseSayVoices((await run(SAY, ['-v', '?'], { timeout: 15_000 })).stdout))
}

/**
 * The voice for a line: the requested one (must be installed — `say` silently falls back to the default for unknown
 * names), a Polish voice for Polish text, otherwise the system voice (undefined: no `-v`).
 */
export function pickVoice(text: string, voices: readonly TempVoiceInfo[], requested?: string): string | undefined {
  const want = requested?.trim().toLowerCase()
  if (want) {
    // Without the list (couldn't run `say -v ?`) the name goes through as given.
    if (!voices.length) return requested!.trim()
    // "Daniel" picks "Daniel (English (UK))", as `say -v Daniel` would.
    const hit = voices.find((v) => v.name.toLowerCase() === want) ?? voices.find((v) => v.name.split(' (')[0]!.toLowerCase() === want)
    if (!hit) throw badRequest(`The voice “${requested!.trim()}” is not installed on this Mac (System Settings → Accessibility → Spoken Content)`)
    return hit.name
  }
  if (!looksPolish(text)) return undefined
  const polish = voices.filter((v) => v.locale.toLowerCase().startsWith('pl'))
  return (polish.find((v) => PREFERRED_POLISH.includes(v.name)) ?? polish[0])?.name
}

/** say's words-per-minute, within what still sounds like speech. */
export function clampRate(rate: unknown): number | undefined {
  const n = Number(rate)
  return rate == null || rate === '' || !Number.isFinite(n) ? undefined : Math.round(Math.min(400, Math.max(90, n)))
}

/** "Temp voice · Nie wiem, czy to…" */
export function tempVoiceName(text: string): string {
  const plain = speakableText(text)
  const short = plain.split(' ').slice(0, 6).join(' ').slice(0, 40).trimEnd()
  return `Temp voice · ${short}${short.length < plain.length ? '…' : ''}`
}

/** Speaks the line into an AAC file in `workDir` (the caller imports and removes it). */
export async function synthesizeTempVoice(opts: { text: string; voice?: string; rate?: number; workDir: string }): Promise<{ path: string; text: string; voice?: string; rate?: number }> {
  const text = speakableText(opts.text)
  if (!text) throw badRequest('Write the line to speak first')
  if (text.length > MAX_CHARS) throw badRequest(`Temp voices take up to ${MAX_CHARS} characters at a time`)
  assertSay()
  const voices = await listSayVoices().catch(() => [])
  const voice = pickVoice(text, voices, opts.voice)
  const rate = clampRate(opts.rate)
  const id = nanoid(8)
  const aiff = join(opts.workDir, `say-${id}.aiff`)
  const out = join(opts.workDir, `say-${id}.m4a`)
  try {
    // execFile, no shell; `--` so a line starting with "-" isn't read as an option.
    await run(SAY, [...(voice ? ['-v', voice] : []), ...(rate ? ['-r', String(rate)] : []), '-o', aiff, '--', text], { timeout: 120_000 })
    await runFfmpeg(['-i', aiff, '-vn', '-ac', '1', '-c:a', 'aac', '-b:a', '128k', out])
  } catch (err) {
    await rm(out, { force: true })
    throw new ApiError(500, `macOS speech failed: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    await rm(aiff, { force: true })
  }
  return { path: out, text, voice, rate }
}
