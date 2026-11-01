"""
Blender previs export for Wildroom (docs/blender-previs.md).

Renders each shot of a grey-box scene — a stretch of the timeline seen by one camera — as the files LTX on the GPU
follows for its camera guide, and writes a motion-import file that brings them into a project and onto story shots:

  <out>/<shot>_layout.mp4   each object in its own colour, studio-shaded (Workbench, Standard colour): the guide
  <out>/<shot>_depth.mp4    grey depth, light = near, one fixed range per shot: the Union Control guide
  <out>/<shot>_first.png    the layout's first frame: what the shot's keyframe is drawn over
  <out>/cameras.json        each shot's camera: lens and world matrix per frame
  <out>/previs.json         motion-import file (pnpm wildroom:import <out>/previs.json --project "…")

Shots come from timeline markers bound to cameras (Ctrl+B in the timeline): a marker starts a shot, the next one ends
it. A marker named like a story shot ("2.3" or "7") attaches the render to that shot; others go to shots 1, 2, 3… in
order. Without camera markers the whole frame range is one shot of the scene camera. Each shot is cut to 8k+1 frames
(LTX's frame grid) and at most 10 s.

Run headless:   blender -b scene.blend -P scripts/blender/previs_export.py -- --out ~/Projects/Blender/previs/scene
In a session:   PREVIS_ARGS = ["--out", "…"]; exec(open(".../previs_export.py").read())   (e.g. over the Blender MCP)

Options: --out DIR (default: <blend folder>/previs/<blend name>), --size 1280x704 (both multiples of 64; 1920x1088
for 1080p), --fps 24, --no-depth, --shots 1,3 (only these markers, 1-based), --near/--far metres (default: from the
camera's view of the scene), --look studio|flat, --cast "blue=Maja,green=Daniel" (who each coloured figure is: the
storyboard names them when it draws a shot's still over the render). The .blend itself is never saved; every render
setting is put back afterwards.
"""

import argparse
import json
import math
import os
import re
import sys

import bpy
from mathutils import Vector

MAX_SECONDS = 10
DEPTH_MATERIAL = "WILDROOM_previs_depth"
PREVIS_WORLD = "WILDROOM_previs_world"
# What shows through where there is no geometry: a mid grey, never black (the model reads black as night sky).
BACKGROUND = (0.32, 0.32, 0.33)


def depth_world():
    """A black world for the depth render: nothing there reads as far away (black), whatever the scene's world is."""
    w = bpy.data.worlds.get(PREVIS_WORLD + "_depth") or bpy.data.worlds.new(PREVIS_WORLD + "_depth")
    w.color = (0.0, 0.0, 0.0)
    for n in w.node_tree.nodes if w.node_tree else []:
        if n.type == "BACKGROUND":
            n.inputs["Color"].default_value = (0.0, 0.0, 0.0, 1.0)
            n.inputs["Strength"].default_value = 0.0
    return w


def grey_box_look(scene, look):
    """The layout render's look. "studio": object colours with soft studio shading and Standard colour (clean,
    saturated, like a viewport playblast); "flat": unshaded colours. Filmic/AgX would wash the colours out."""
    sh = scene.display.shading
    sh.light = "STUDIO" if look == "studio" else "FLAT"
    sh.color_type = "OBJECT"
    sh.show_shadows = False
    sh.show_cavity = False
    vs = scene.view_settings
    vs.view_transform, vs.look, vs.exposure, vs.gamma = "Standard", "None", 0.0, 1.0
    if scene.world is None:
        scene.world = bpy.data.worlds.new(PREVIS_WORLD)
    scene.world.color = BACKGROUND


def parse_args():
    argv = globals().get("PREVIS_ARGS")
    if argv is None:
        argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    p = argparse.ArgumentParser(prog="previs_export")
    p.add_argument("--out")
    p.add_argument("--size", default="1280x704")
    p.add_argument("--fps", type=int, default=24)
    p.add_argument("--no-depth", action="store_true")
    p.add_argument("--shots")
    p.add_argument("--near", type=float)
    p.add_argument("--far", type=float)
    p.add_argument("--look", choices=["studio", "flat"], default="studio")
    # Who each coloured figure is, named when the keyframe is drawn over the render: "blue=Maja,green=Daniel".
    p.add_argument("--cast", default="")
    a = p.parse_args(argv)
    w, h = (int(v) for v in a.size.lower().split("x"))
    if w % 64 or h % 64:
        raise SystemExit(f"--size {a.size}: both sides must be multiples of 64 (e.g. 1280x704, 1920x1088)")
    blend = bpy.data.filepath
    name = os.path.splitext(os.path.basename(blend))[0] if blend else "untitled"
    out = os.path.expanduser(a.out) if a.out else os.path.join(os.path.dirname(blend) or os.path.expanduser("~"), "previs", name)
    only = {int(s) for s in a.shots.split(",")} if a.shots else None
    return a, w, h, os.path.abspath(out), name, only


def ltx_frames(n, fps):
    """The longest 8k+1 frame count that fits in n frames and in MAX_SECONDS."""
    n = min(n, MAX_SECONDS * fps + 1)
    return max(1, 1 + ((n - 1) // 8) * 8)


def shot_list(scene, fps):
    """(name, camera, start, frames) per shot, from camera markers or the scene camera over the frame range."""
    marks = sorted((m for m in scene.timeline_markers if m.camera), key=lambda m: m.frame)
    end = scene.frame_end + 1
    if not marks:
        if not scene.camera:
            raise SystemExit("The scene has no camera: add one, or bind cameras to timeline markers")
        return [(1, None, scene.camera, scene.frame_start, ltx_frames(end - scene.frame_start, fps))]
    shots = []
    for i, m in enumerate(marks):
        stop = marks[i + 1].frame if i + 1 < len(marks) else end
        if stop - m.frame < 9:
            print(f"[previs] skipping marker {m.name!r}: shorter than 9 frames")
            continue
        # Its place among the markers (1-based), kept when one before it is skipped: --shots and unnamed shots use it.
        shots.append((i + 1, m.name, m.camera, m.frame, ltx_frames(stop - m.frame, fps)))
    return shots


def story_ref(name, index):
    """A marker named like a story shot ("2.3", "7") targets it; anything else goes by order."""
    if name and re.fullmatch(r"\d+(\.\d+)?", name.strip()):
        return name.strip() if "." in name else int(name)
    return index


def depth_range(scene, camera, start, frames):
    """Nearest and farthest visible geometry over the shot (bounding-box corners in front of the camera), padded."""
    near, far = math.inf, 0.0
    step = max(1, frames // 8)
    for f in range(start, start + frames, step):
        scene.frame_set(f)
        inv = camera.matrix_world.inverted()
        for ob in scene.objects:
            if ob.type not in {"MESH", "CURVE", "SURFACE", "META", "FONT"} or ob.hide_render:
                continue
            for corner in ob.bound_box:
                z = -(inv @ (ob.matrix_world @ Vector(corner))).z
                if z > camera.data.clip_start:
                    near, far = min(near, z), max(far, z)
    if not math.isfinite(near):
        return camera.data.clip_start, min(camera.data.clip_end, 100.0)
    return max(camera.data.clip_start, near * 0.9), far * 1.1


def depth_material(near, far):
    """Emission = 1 at `near`, 0 at `far` (light = near), from the camera's view depth: no compositor needed."""
    mat = bpy.data.materials.get(DEPTH_MATERIAL) or bpy.data.materials.new(DEPTH_MATERIAL)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    cam = nt.nodes.new("ShaderNodeCameraData")
    remap = nt.nodes.new("ShaderNodeMapRange")
    remap.clamp = True
    remap.inputs["From Min"].default_value = near
    remap.inputs["From Max"].default_value = far
    remap.inputs["To Min"].default_value = 1.0
    remap.inputs["To Max"].default_value = 0.0
    emit = nt.nodes.new("ShaderNodeEmission")
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(cam.outputs["View Z Depth"], remap.inputs["Value"])
    nt.links.new(remap.outputs["Result"], emit.inputs["Color"])
    nt.links.new(emit.outputs["Emission"], out.inputs["Surface"])
    return mat


class Saved:
    """Every scene setting the export touches, put back afterwards (the .blend is never saved)."""

    def __init__(self, scene):
        r = scene.render
        self.scene = scene
        self.values = {
            "engine": r.engine,
            "filepath": r.filepath,
            "res": (r.resolution_x, r.resolution_y, r.resolution_percentage),
            "fps": (r.fps, r.fps_base),
            "media": getattr(r.image_settings, "media_type", None),
            "format": r.image_settings.file_format,
            "range": (scene.frame_start, scene.frame_end, scene.frame_current),
            "camera": scene.camera,
            "override": bpy.context.view_layer.material_override,
            "film": r.film_transparent,
        }
        sh = scene.display.shading
        self.shading = (sh.light, sh.color_type, sh.show_shadows, sh.show_cavity, sh.studio_light)
        vs = scene.view_settings
        self.view = (vs.view_transform, vs.look, vs.exposure, vs.gamma)
        self.world = scene.world
        self.world_color = tuple(scene.world.color) if scene.world else None

    def restore(self):
        s, r, v = self.scene, self.scene.render, self.values
        r.engine = v["engine"]
        r.filepath = v["filepath"]
        r.resolution_x, r.resolution_y, r.resolution_percentage = v["res"]
        r.fps, r.fps_base = v["fps"]
        if v["media"] is not None:
            r.image_settings.media_type = v["media"]
        r.image_settings.file_format = v["format"]
        s.frame_start, s.frame_end, cur = v["range"]
        s.camera = v["camera"]
        bpy.context.view_layer.material_override = v["override"]
        r.film_transparent = v["film"]
        sh = s.display.shading
        sh.light, sh.color_type, sh.show_shadows, sh.show_cavity, sh.studio_light = self.shading
        vs = s.view_settings
        vs.view_transform, vs.look, vs.exposure, vs.gamma = self.view
        if self.world is None and s.world is not None and s.world.name == PREVIS_WORLD:
            bpy.data.worlds.remove(s.world)
        s.world = self.world
        if self.world is not None and self.world_color is not None:
            self.world.color = self.world_color
        s.frame_set(cur)


def eevee_engine():
    ids = {e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items}
    return "BLENDER_EEVEE_NEXT" if "BLENDER_EEVEE_NEXT" in ids else "BLENDER_EEVEE"


def set_output(scene, kind):
    """Video (H.264 MP4) or a still (PNG). Blender 5 picks the media type first; older versions only the format."""
    s = scene.render.image_settings
    if hasattr(s, "media_type"):
        s.media_type = "VIDEO" if kind == "video" else "IMAGE"
    s.file_format = "FFMPEG" if kind == "video" else "PNG"


def render_movie(scene, path):
    r = scene.render
    set_output(scene, "video")
    r.ffmpeg.format = "MPEG4"
    r.ffmpeg.codec = "H264"
    r.ffmpeg.constant_rate_factor = "HIGH"
    r.ffmpeg.audio_codec = "NONE"
    r.filepath = path
    bpy.ops.render.render(animation=True)
    # Blender appends the frame range to some names: find what it wrote.
    if not os.path.exists(path):
        folder, base = os.path.split(path)
        stem = os.path.splitext(base)[0]
        found = [f for f in os.listdir(folder) if f.startswith(stem) and f.endswith(".mp4")]
        if found:
            os.replace(os.path.join(folder, found[0]), path)


def main():
    a, width, height, out, blend_name, only = parse_args()
    figures = [
        {"color": color.strip(), "name": name.strip()}
        for color, _, name in (pair.partition("=") for pair in a.cast.split(",") if "=" in pair)
        if color.strip() and name.strip()
    ]
    scene = bpy.context.scene
    os.makedirs(out, exist_ok=True)
    saved = Saved(scene)
    # Frames are rendered one to one: another rate would play the blocking faster or slower than it was animated.
    scene_fps = scene.render.fps / (scene.render.fps_base or 1.0)
    if abs(scene_fps - a.fps) > 0.01:
        raise SystemExit(f"The scene runs at {scene_fps:g} fps, the export at {a.fps}: set the scene to {a.fps} fps (Output properties) and retime, or pass --fps {scene_fps:g}")
    shots = shot_list(scene, a.fps)
    media, entries, cameras = [], [], []
    try:
        r = scene.render
        r.resolution_x, r.resolution_y, r.resolution_percentage = width, height, 100
        r.fps, r.fps_base = a.fps, 1.0
        r.film_transparent = False
        for i, name, camera, start, frames in shots:
            if only and i not in only:
                continue
            key = f"shot{i:02d}"
            scene.camera = camera
            scene.frame_start, scene.frame_end = start, start + frames - 1

            # Grey box: each object in its own colour, studio-shaded, Standard colour (no washed-out Filmic/AgX).
            r.engine = "BLENDER_WORKBENCH"
            grey_box_look(scene, a.look)
            layout = os.path.join(out, f"{key}_layout.mp4")
            render_movie(scene, layout)
            first = os.path.join(out, f"{key}_first.png")
            scene.frame_set(start)
            set_output(scene, "image")
            r.filepath = first
            bpy.ops.render.render(write_still=True)

            depth = None
            if not a.no_depth:
                near, far = (a.near, a.far) if a.near and a.far else depth_range(scene, camera, start, frames)
                bpy.context.view_layer.material_override = depth_material(near, far)
                r.engine = eevee_engine()
                # Empty space is "far" (black), not the grey-box background or an HDRI that would read as geometry.
                world_was = scene.world
                scene.world = depth_world()
                depth = os.path.join(out, f"{key}_depth.mp4")
                try:
                    render_movie(scene, depth)
                finally:
                    scene.world = world_was
                bpy.context.view_layer.material_override = saved.values["override"]

            lens, matrix = [], []
            for f in range(start, start + frames):
                scene.frame_set(f)
                lens.append(round(camera.data.lens, 3))
                matrix.append([round(v, 5) for row in camera.matrix_world for v in row])
            cameras.append({"key": key, "camera": camera.name, "start": start, "frames": frames, "lens": lens, "matrix": matrix})

            media += [{"key": f"{key}_layout", "path": layout, "name": f"Previs {name or i} · layout"}]
            media += [{"key": f"{key}_first", "path": first, "name": f"Previs {name or i} · first frame"}]
            previs = {"layout": f"@@{key}_layout", "firstFrame": f"@@{key}_first", "frames": frames, "source": f"{blend_name}.blend · {camera.name}"}
            if depth:
                media.append({"key": f"{key}_depth", "path": depth, "name": f"Previs {name or i} · depth"})
                previs["depth"] = f"@@{key}_depth"
            if figures:
                previs["figures"] = figures
            entries.append({"shot": story_ref(name, i), "previs": previs})
            print(f"[previs] {key}: {camera.name}, frames {start}–{start + frames - 1} ({frames / a.fps:.2f} s)")
    finally:
        saved.restore()

    with open(os.path.join(out, "cameras.json"), "w") as fh:
        json.dump({"fps": a.fps, "size": [width, height], "shots": cameras}, fh)
    with open(os.path.join(out, "previs.json"), "w") as fh:
        json.dump({"version": 1, "fps": a.fps, "media": media, "shots": entries}, fh, indent=1)
    print(f"[previs] done: {len(entries)} shot(s) in {out}")
    print(f'[previs] import: pnpm wildroom:import "{os.path.join(out, "previs.json")}" --project "<project name>"')
    return out


if __name__ == "__main__" or "PREVIS_ARGS" in globals():
    main()
