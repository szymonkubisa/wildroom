import { mkdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Hono } from 'hono'
import { TEMP_VOICE_KEYWORD, type TempVoiceRequest } from '../../shared/types/api'
import type { AppDeps } from '../app'
import { badRequest, readJson } from '../http'
import { speakableText } from '../services/speechText'
import { listSayVoices, synthesizeTempVoice, tempVoiceName } from '../services/tempVoice'

/** Free macOS voices for animatics (timing and pacing before any paid TTS). */
export function tempVoiceRoutes(deps: AppDeps) {
  const { media, env, registry } = deps
  const r = new Hono()

  r.get('/temp-voice/voices', async (c) => c.json(await listSayVoices()))

  r.post('/projects/:projectId/temp-voice', async (c) => {
    const body = await readJson<TempVoiceRequest>(c)
    if (typeof body.text !== 'string' || !speakableText(body.text)) throw badRequest('Write the line to speak first')
    if (body.voice !== undefined && typeof body.voice !== 'string') throw badRequest('voice must be a voice name')
    const project = registry.require(c.req.param('projectId'))
    const dir = join(env.tmpDir, 'tools')
    mkdirSync(dir, { recursive: true })
    // Held while speaking, so closing the editor meanwhile doesn't unmount the project under the import.
    const asset = await registry.holdDuring(project.id, async () => {
      const out = await synthesizeTempVoice({ text: body.text, voice: body.voice, rate: body.rate, workDir: dir })
      try {
        return await media.importFile(out.path, {
          name: (typeof body.name === 'string' && body.name.trim().slice(0, 200)) || tempVoiceName(out.text),
          source: 'derived',
          projectId: project.id,
          role: 'dialogue',
          keywords: [TEMP_VOICE_KEYWORD],
          meta: { tempVoice: true, voice: out.voice ?? 'system default', text: out.text, ...(out.rate ? { rate: out.rate } : {}) },
          move: true,
        })
      } finally {
        await rm(out.path, { force: true }).catch(() => {})
      }
    })
    return c.json(asset, 201)
  })

  return r
}
