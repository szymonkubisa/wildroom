---
name: blender-previs
description: Build a grey-box previs in Blender over the Blender MCP (scene, blocking, camera moves) and export it as camera guides for LTX-2.5 on RunPod in Wildroom / Wildroom. Use when the user asks to block a shot, plan camera moves in Blender, make a previs or "blocking" for a story shot, or to have LTX follow a Blender camera.
---

# Blender previs → LTX camera guide

The grey box sets the camera, timing and where things are; the start frame and the prompt set the look. LTX-2.5 on the
GPU follows the render with Lightricks' Layout-To-Render IC-LoRA (or a depth render with Union Control). Full design:
`docs/blender-previs.md`. Export: `scripts/blender/previs_export.py`. Import: `docs/motion-import.md` → "Blender previs".

## Files and safety

- Work in a **new** `.blend` under `~/Projects/Blender/` (e.g. `previs_<story>.blend`). Check the open file first
  (`get_blendfile_summary_path_info`): never save over, or change, a file that has unsaved changes the user made.
- Inspect before changing (`get_objects_summary`); prefer `bpy.ops` for primitives, the data API for exact values.
- Units: metres. Scene fps 24. Every shot 8k+1 frames (25, 49, 73, 97, 121…), at most 10 s (241 frames).

## Building the grey box

- Characters: blocky mannequins, not capsules — box torso, a smooth ball head (48 segments, shade smooth), box upper
  arms and forearms, thighs and shins, posed for the action (forearms on the table, sitting on a chair). One strong,
  saturated object colour per character (`ob.color`: blue, green, red, teal, purple, yellow…), the same colour on every
  part, so "the teal one" names a person in prompts. Props in muted colours, set dressing in greys.
- Place: a closed room or street with mid-grey walls (panel seams help parallax), a darker floor and a few landmarks
  (window, counter, door). Never leave empty sky behind the action: the export's mid-grey background is better than
  black, but walls are best. Leave liquids, smoke, crowds and FX out: the model fills them in.
- Check orientation before exporting: render a still from a high wide view and confirm everyone faces where they
  should (a rig rotated the wrong way puts every chair back toward the table).
- Animate blocking with keyframes on the capsules (walk paths, turns). One action per ~3 s.

## Cameras (brief it like a camera operator)

- One camera object per setup; bind cameras to timeline markers (marker = cut). Name markers after the story shot
  they render ("1.2", "7") so the import lands on that shot.
- Moves on a path or keyframes, aimed at a separate **target empty** offset from the subject (not locked to the head):
  it reads as a real operator. Animate the lens for zooms; add subtle handheld noise (F-curve Noise modifier, tiny
  amplitude) when the shot should feel carried.
- Dialogue: keep the 180° rule — all cameras on one side of the line between speakers; over-the-shoulder pairs mirror.
- Show the user the camera view (`render_viewport_to_path` / a viewport screenshot) and adjust before exporting.

## Export and import

```bash
/Applications/Blender.app/Contents/MacOS/Blender -b ~/Projects/Blender/previs_x.blend -P scripts/blender/previs_export.py -- --out ~/Projects/Blender/previs/x --size 1280x704
pnpm wildroom:import ~/Projects/Blender/previs/x/previs.json --project "<project name>"
```

Headless on a saved file is safest. Inside the live session: `PREVIS_ARGS = ["--out", "…"]` then exec the script; it
puts every render setting back and never saves the file. 1920x1088 for 1080p renders.

## Prompts and stills for the guided shot

- The shot's still is drawn **over the previs's first frame** automatically: Stills sends it as image 1 ("the blocking
  of this shot") with the cast and the scene's opening still, and names who each colour is. Export with
  `--cast "teal=Nina,blue=Ola"` (story character names) so the prompt can say "the teal figure is Nina". The app
  refuses to render a shot whose still is the grey frame itself — the output would stay grey.
- The video prompt: one or two sentences of look and action. Never "clay", "grey box", "3D", "Blender" or "render";
  no camera directions (the guide carries the camera).
- No start frame: the depth guide (Union) is used instead; the look then comes from the prompt alone. The grey box
  alone renders grey, so the app refuses it without a start frame.
- Anyone who enters the frame during the shot must be in the keyframe already, or named in the prompt ("the bald man
  in the purple shirt leans into the right foreground"): an unexplained mannequin head came out as a literal purple
  ball.
- Keyframes for several shots of one scene: draw the widest shot first as the master (name the camera angle and every
  seat by position), then each other shot from [its previs frame, the master] so faces and clothes stay the same.
- The start frame goes in as Layout-To-Render's "look still" (a guide at frame −1), never pinned as frame 0: pinned,
  the camera stayed behind the subject at 720p. Depth renders at 128-px steps (720p 16:9 → 1280×768).
- Layout-To-Render is silent in ComfyUI: plan the sound on the timeline, or audio to follow for dialogue.

## Costs

Rendering on RunPod is paid: ask the user before starting the GPU or updating the volume.
