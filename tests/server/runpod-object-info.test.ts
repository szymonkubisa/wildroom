import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type ApiGraph, type CoreGraphInput, buildCoreGraph, buildUpscaleGraph } from '../../src/server/providers/runpod/graph'

/**
 * Every node and input our LTX graphs send exists on the pod: checked against ComfyUI's /object_info as saved from a
 * prepared volume (tests/fixtures/runpod-object-info.json, trimmed to the classes the graphs use). Save it again after
 * a volume update changes the custom nodes.
 */
const FIXTURE = join(__dirname, '../fixtures/runpod-object-info.json')
type ObjectInfo = Record<string, { input?: { required?: Record<string, unknown>; optional?: Record<string, unknown> } }>

const base: CoreGraphInput = { prompt: 'a rainy street', fps: 24, seconds: 5, width: 1280, height: 704, seed: 1, audio: true, precision: 'int8', prefix: 'wildroom/t' }
const variants: Record<string, CoreGraphInput | (() => ApiGraph)> = {
  'text to video': base,
  'image to video, end and mid frames': { ...base, image: 's.png', lastImage: 'e.png', midImages: ['m.png'] },
  'references, location and voices': { ...base, references: ['a.png', 'b.png'], background: 'p.png', voices: ['v1.wav'] },
  'audio to follow': { ...base, image: 's.png', audioFile: 'a.wav' },
  'continue a clip': { ...base, continueClip: 'c.mp4' },
  '4K detail pass': { ...base, precision: 'bf16', upscale4k: true },
  'layout guide with a start frame': { ...base, image: 's.png', guide: { video: 'g.mp4', kind: 'layout', strength: 1 } },
  'depth guide': { ...base, width: 1280, height: 768, guide: { video: 'd.mp4', kind: 'depth', strength: 1 } },
  'layout guide with references': { ...base, references: ['a.png'], guide: { video: 'g.mp4', kind: 'layout', strength: 0.8 } },
  'upscaler (V2V refine to 1080p)': () =>
    buildUpscaleGraph({ video: 's.mp4', frames: 97, fps: 24, width: 1920, height: 1088, seed: 1, audio: true, precision: 'int8', prefix: 'wildroom/t' }),
}

describe.skipIf(!existsSync(FIXTURE))('LTX graphs against the pod’s nodes', () => {
  const info = existsSync(FIXTURE) ? (JSON.parse(readFileSync(FIXTURE, 'utf8')) as ObjectInfo) : {}
  for (const [name, input] of Object.entries(variants)) {
    it(`uses only nodes and inputs the pod has: ${name}`, () => {
      const graph: ApiGraph = typeof input === 'function' ? input() : buildCoreGraph(input)
      const problems: string[] = []
      for (const [id, node] of Object.entries(graph)) {
        const spec = info[node.class_type]
        if (!spec) {
          problems.push(`${id}: no node ${node.class_type}`)
          continue
        }
        const known = { ...spec.input?.required, ...spec.input?.optional }
        // "format.codec", "values.a": sub-inputs of a dynamic input ("format", "values"), listed under their parent.
        for (const key of Object.keys(node.inputs)) if (!(key.split('.')[0]! in known)) problems.push(`${id} ${node.class_type}: no input "${key}"`)
      }
      expect(problems).toEqual([])
    })
  }
})
