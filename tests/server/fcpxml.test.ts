import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type FcpAsset, rational, writeFcpxml } from '../../src/server/services/fcpxml'
import { applyOp, makeMediaClip, makeTitle, ops } from '../../src/shared/timeline'
import type { MediaInfo } from '../../src/shared/timeline'
import { secondsToFlicks } from '../../src/shared/time/flicks'
import { createEmptyDoc } from '../../src/shared/types/project-doc'

let n = 0
const newId = () => `c${++n}`

const assets = new Map<string, FcpAsset>([
  ['v1', { id: 'v1', name: 'Shot 1', kind: 'video', path: '/Users/me/Movies/Film Projects/Media/ab/v1.mp4', durationSeconds: 10, fps: 24, width: 1280, height: 720, hasVideo: true, hasAudio: true }],
  ['v2', { id: 'v2', name: 'Shot 2', kind: 'video', path: '/Users/me/Movies/Film Projects/Media/cd/v2.mp4', durationSeconds: 10, fps: 24, width: 1280, height: 720, hasVideo: true, hasAudio: false }],
  ['m', { id: 'm', name: 'Score', kind: 'audio', path: '/tmp/score.wav', durationSeconds: 30, hasVideo: false, hasAudio: true }],
])
const media = (id: string): MediaInfo | undefined => {
  const a = assets.get(id)
  return a && { kind: a.kind, durationFlicks: secondsToFlicks(a.durationSeconds ?? 0), hasVideo: a.hasVideo, hasAudio: a.hasAudio, fps: a.fps }
}
const ctx = { newId, media }

function buildDoc() {
  let doc = createEmptyDoc({ fps: 24, fpsAuto: false, width: 1920, height: 1080 })
  const a = makeMediaClip({ assetId: 'v1', media: media('v1')!, fps: 24, durationFrames: 120, role: 'effects', newId })
  const b = makeMediaClip({ assetId: 'v2', media: media('v2')!, fps: 24, durationFrames: 120, newId })
  doc = applyOp(doc, ops.appendToSpine([a, b]), ctx).doc
  doc = applyOp(doc, ops.setTransition(a.id, 'out', { type: 'dissolve', duration: 12 }), ctx).doc
  doc = applyOp(doc, ops.connectAt(0, [makeMediaClip({ assetId: 'm', media: media('m')!, fps: 24, durationFrames: 200, role: 'music', newId })], -1), ctx).doc
  doc = applyOp(doc, ops.connectAt(30, [makeTitle({ template: 'basic', text: 'Chapter <One> & "Two"', duration: 48, newId })], 1), ctx).doc
  doc = applyOp(doc, ops.addMarker(150, 'todo', 'Fix colour'), ctx).doc
  return doc
}

describe('FCPXML writer', () => {
  it('formats rational times', () => {
    expect(rational(114, 24)).toBe('19/4s')
    expect(rational(48, 24)).toBe('2s')
    expect(rational(0, 24)).toBe('0s')
  })

  it('maps overlap transitions onto handles and keeps the sequence length', () => {
    const { xml } = writeFcpxml(buildDoc(), 'Film', assets)
    // A: 120 frames minus half the 12-frame transition (6) → 114 frames; B starts where A ends, 6 frames into its media.
    expect(xml).toMatch(/<asset-clip[^>]*offset="0s"[^>]*start="0s"[^>]*duration="19\/4s"/)
    expect(xml).toMatch(/<transition name="Cross Dissolve" offset="9\/2s" duration="1\/2s"><filter-video ref="r\d+" name="Cross Dissolve"\/><\/transition>/)
    expect(xml).toMatch(/<asset-clip[^>]*offset="19\/4s"[^>]*start="1\/4s"[^>]*duration="19\/4s"/)
    expect(xml).toMatch(/<sequence[^>]*duration="19\/2s"/)
  })

  it('nests connected clips, titles and markers in their parent with lanes and roles', () => {
    const { xml } = writeFcpxml(buildDoc(), 'Film', assets)
    expect(xml).toMatch(/<asset-clip lane="-1" offset="0s" name="[^"]*" start="0s" duration="25\/3s"[^>]*audioRole="music"/)
    expect(xml).toMatch(/<title lane="1" offset="5\/4s"/)
    expect(xml).toContain('Chapter &lt;One&gt; &amp; &quot;Two&quot;')
    expect(xml).toMatch(/<marker start="[^"]+" duration="1\/24s" value="Fix colour" completed="0"\/>/)
    expect(xml).toContain('src="file:///Users/me/Movies/Film%20Projects/Media/ab/v1.mp4"')
  })

  it('produces well-formed XML', () => {
    const dir = join('tests/.tmp', 'fcpxml')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'film.fcpxml')
    writeFileSync(file, writeFcpxml(buildDoc(), 'Film', assets).xml)
    expect(() => execFileSync('xmllint', ['--noout', file], { stdio: 'pipe' })).not.toThrow()
    rmSync(dir, { recursive: true, force: true })
  })
})
