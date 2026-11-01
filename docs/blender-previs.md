# Blender previs → LTX-2.5 on RunPod

A grey-box scene built in Blender sets the camera and the blocking of a generated shot. The scene is rendered as a
plain playblast; LTX-2.5 on a RunPod GPU follows that video for the camera path, the timing and where everyone stands,
and takes the look from a styled first frame and a short prompt.

- **Structure layer**: the previs video — camera, timing, blocking.
- **Style layer**: the first frame, the prompt and the shot's references.

The camera and the blocking hold, the 180° rule holds in dialogue, fewer paid renders miss, and the same blocking can
be rendered again in another style.

## Models

Both are installed on the RunPod volume by `scripts/runpod/setup-volume.sh` (**Prepare volume** / **Update volume** in
the RunPod settings; an update downloads only what is missing):

- **`Lightricks/LTX-2.5-22b-IC-LoRA-Layout-To-Render`** — follows the grey playblast as it is: camera path and object
  placement. The look comes from an art-directed first frame (optionally mid and end frames) and a 1–2 sentence
  prompt. The model is gated: accept its licence once on Hugging Face ("Agree and access").
- **`Lightricks/LTX-2.3-22b-IC-LoRA-Union-Control`** (ref0.5) — follows a **depth** render instead, for shots without
  a first frame. Depth comes from Blender (light = near, one fixed range per shot), never estimated on the pod.

Both guides run in the two-stage LTX-2.5 graph (`src/server/providers/runpod/graph.ts`). The graphs are checked
against the pod's `/object_info` (`tests/fixtures/runpod-object-info.json`).

## In the app

The RunPod LTX-2.5 model has a **Camera guide (previs)** input:

- **Guide type**: *Grey box* (the previs render; it needs a start frame for the look — without one the clip comes out
  grey, so the app refuses it) or *Depth* (for shots without a start frame).
- **Guide strength**: 0.3–1, default 1.
- The clip's length is the guide's length (LTX's 8k+1 frame grid, at most 10 s). A guide can't be combined with
  *Continue from*. The output has no audio unless a voice clip is added (A2V).

On a story shot, a previs shows as **Previs** with a thumbnail in the shot's media — imported with the shot (below) or
dropped there from the Library. Generating the shot sends the previs as its guide: grey box when the shot has a still,
depth otherwise, with a short prompt and no camera wording (the camera comes from the guide).

**Stills over the previs**: when a shot has a previs with a first frame, Stills draws its keyframe over it — the frame
goes in as image 1 ("the blocking of shot N") with the rule to keep its camera, lens, framing and where everyone is,
to draw real people for the coloured figures (named from `previs.figures`: "the teal figure is Nina") and never the
figures or grey surfaces themselves. The cast's references and the scene's opening still follow, as for any keyframe.
Rendering a shot whose still is the grey previs frame is refused.

## Blender side

`scripts/blender/previs_export.py` renders each shot of a scene and writes a motion-import file:

```bash
blender -b scene.blend -P scripts/blender/previs_export.py -- --out ~/Projects/Blender/previs/scene --cast "teal=Nina,blue=Ola"
pnpm wildroom:import ~/Projects/Blender/previs/scene/previs.json --project "My Film"
```

- Shots come from timeline markers bound to cameras: a marker starts a shot, the next one ends it. A marker named like
  a story shot (`2.3` or `7`) attaches the render to that shot. Each shot is cut to 8k+1 frames and at most 10 s.
- Per shot: `<shot>_layout.mp4` (each object in its own colour, studio-shaded), `<shot>_depth.mp4`, `<shot>_first.png`
  and the camera in `cameras.json`.
- Options: `--size 1280x704` (multiples of 64; `1920x1088` for 1080p), `--fps 24`, `--no-depth`, `--shots 1,3`,
  `--near` / `--far`, `--look studio|flat`, `--cast`. The `.blend` is never saved; every render setting is put back.
- The import format is in [motion-import.md](motion-import.md#blender-previs-on-story-shots).

Claude Code can build the scene over the Blender MCP; the rules it follows are in
`.claude/skills/blender-previs/SKILL.md`:

- Metres. Characters as blocky mannequins in one strong colour each, with a "nose" showing where they look.
- Camera on a path with a separate target (offset, not locked to the head), animated lens, subtle handheld noise.
- The 180° rule; a shot list written like a camera operator's: rails, targets, cuts.
- Liquids and FX left out.
- The prompt written from the render: for LTX, 1–2 sentences of look and action, never "clay", "3D" or "Blender".
- New `.blend` files go in `~/Projects/Blender/`; open files with unsaved changes are never overwritten.

## What works

| Setup | Camera follows the previs? |
|---|---|
| Grey box + keyframe as the look still | **yes** — behind → profile → top-down, in 720p and 1080p |
| Depth, no keyframe | **yes** (depth renders in 128-px steps, e.g. 1280×768) |
| Grey box, no keyframe | the path yes, but the output is the grey box itself — refused |
| No guide, camera written in the prompt | no — the model fakes the move with cuts |

- A six-person table scene with Seedream keyframes (the wide shot first as the master, the others from their previs
  frame and the master): push-ins, tracks and orbits follow, and everyone keeps their seat, face and clothes.
- Whoever enters the frame mid-shot must be in the keyframe or named in the prompt — otherwise the model invents
  them from the coloured figure.
- The studio look (Workbench studio light, object colours, view transform *Standard*, mid-grey background, a closed
  grey room) reads better than Blender's AgX/Filmic default, which washes the colours out.

## Limits

- Two IC-LoRAs together (MSR references + Layout-To-Render) are not documented by Lightricks.
- The Layout-To-Render guide resolution is read from the loader at run time (`latent_downscale_factor`), never
  hard-coded.
