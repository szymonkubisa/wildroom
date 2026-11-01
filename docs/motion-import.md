# Motion import

Build an explainer — boards, frames, elements, motion clips, voice-over, markers, brand — from one JSON file, without
the browser. Meant for scripts and for Claude Code: write the file, run one command, open the project.

```bash
pnpm wildroom:import explainer.json --project "Drama Triangle"
```

- `--create "Name"` makes a new project instead; `"project": "<id or name>"` in the file works too.
- The app (or `pnpm dev`) must be running. `--server` (or `STUDIO_SERVER`) points at it when it isn't on
  `http://127.0.0.1:7777` (the desktop app picks another port when 7777 is taken).
- Everything lands as **one revision** of the project. An editor that has the project open reloads it by itself; if it
  has unsaved edits it asks first.
- Under the hood: `POST /api/projects/:id/motion-import` with the file as the body (headers `Origin: <server>` and
  `X-Studio: 1`). The schema is `src/shared/motion/importSchema.ts`; the importer `src/server/services/motionImport.ts`.

## The file

```jsonc
{
  "version": 1,
  "fps": 24,            // optional: frames below are at this rate (converted to the project's)
  "media":  [ { "key": "statue", "path": "img/statue.png" },
              { "key": "vo1", "path": "audio/scene1.mp3", "role": "dialogue",
                "words": [ { "text": "Meet", "start": 0.12, "end": 0.4 }, … ] } ],
  "fonts":  [ { "key": "serif", "path": "fonts/Fraunces[wght].ttf" } ],
  "boards": [ { "name": "Explainer", "items": [ … board elements … ] } ],
  "timeline": [ … clips, in order … ],
  "markers":  [ { "at": 0, "name": "Scene 1", "kind": "chapter" } ],
  "brand":    { "name": "Dare", "colors": [ { "hex": "#ff3366", "role": "primary" } ] }
}
```

### Media and fonts

- `path` is absolute or relative to the JSON file (the script makes it absolute). Files must be inside your home
  folders (Desktop, Documents, Downloads, Movies, Music, Pictures, Projects), the projects folder or the temp folder.
  `STUDIO_IMPORT_DIRS=/a:/b` adds more.
- A media entry is an image, video or sound; `role` sets a sound's place in the mix (`dialogue`, `music`, `effects`…).
- `words` gives a voice-over its word timings (seconds from the file's start). Captions use them, and so do keys timed
  to words (below). Voices generated in the app have them already.
- A font's family, weight and style are read from the font itself.

### Placeholders

Every key becomes a placeholder. Anywhere in `boards`, `timeline`, `markers` and `brand`, the exact string `"@@key"`
is replaced:

- for media, by the asset's id: `"assetId": "@@statue"`;
- for fonts, by the family name: `"fontFamily": "@@serif"`.

An unknown placeholder stops the import before anything is saved.

### Boards

`{ "id"?: string, "name": string, "replace"?: true, "items": [...] }` — a new board, or with an existing `id` and
`"replace": true`, that board's contents replaced. Elements are stored as the app stores them; anything invalid is
left out (listed in the warnings). Every element needs a unique `id` and `x`, `y`, `w`, `h` (board units). Elements
of a frame carry `"frameId"`.

| kind | main fields |
|---|---|
| `frame` | `name`, `fill` (colour or gradient) — the scene a motion clip plays |
| `text` | `text`, `fontFamily`, `fontSize`, `fontWeight`, `color`, `align`, `lineHeight`; rich text in `spans` (`[{ text, color?, fontFamily?, fontWeight?, fontStyle?, highlight? }]`, joined they must equal `text`); `fontStyle`, `letterSpacing`, `textTransform`, `outline` |
| `shape` | `shape` (`rect` `ellipse` `line` `polyline` `polygon` `path` `arc`), `fill` (colour, `none`, gradient or pattern), `stroke { color, width, cap?, join?, dash? }`, `radius`, `points` (0..1 of the box), `d` + `pathBox`, `arc { start, end }` |
| `asset` | `assetId`, `mask` (`ellipse`/`rounded`), `radius`, `crop { x, y, zoom }`, `stroke`, `adjust { brightness, contrast, saturate, bw }`, `tint { color, amount }`, `duotone { dark, light }` |
| `group` | members point at it with `groupId`; its box is worked out |

On any drawn element: `rotation` (degrees), `shadow { color, blur, x, y }`, `glow { color, blur }`, `blend`
(`multiply` `screen` `overlay` `soft-light` `darken` `lighten` `difference` `add`), `clipBy` (another element's id:
shown only inside it; `clipInvert: true` for outside), `hidden`, `locked`, `name`.

### Timeline

Clips are added in order. `at` says where each starts:

- `"end"` (after the storyline);
- a frame number;
- `{ "clip": "<key of an earlier entry>", "offset": 12 }`.

```jsonc
{ "type": "motion", "key": "scene1", "board": "Explainer", "frame": "Scene 1", "duration": 168,
  "tracks": { "<element id>": { … }, … }, "camera": [ … ], "at": "end", "lane": 1, "span": "timeline" },
{ "type": "audio", "key": "vo1", "media": "@@vo1", "at": { "clip": "scene1", "offset": 6 } },
{ "type": "image" | "video", "media": "@@statue", "at": 48, "lane": 1, "duration": 72 }
```

- `board` and `frame` are ids or names.
- A motion clip at `"end"` with no `lane` goes on the storyline; anything else is connected (`lane` > 0 above, < 0
  below; sound defaults to -1).
- `"span": "timeline"` makes an overlay over the whole timeline (a frame with no fill, so the film shows through).

### Tracks (by element id; keys count from the clip's first frame)

| field | value |
|---|---|
| `opacity` | keys of 0..1 |
| `transform` | keys of `{ x, y, scale, rotation }` — offset from the board place |
| `stretch` | keys of `{ x, y }` — width and height factors |
| `color` | keys of hex colours (mixed in OKLab) |
| `blur` | keys of frame units |
| `reveal` + `revealMode` | keys of 0..1; `typewriter` `words` `words-rise` `words-pop` `words-blur` `letters-rise` `letters-fade` `highlight-sweep` `roll` (+ `rollFrom`) `wipe-left` `wipe-up` `draw` |
| `trim` | keys of `{ start, end }` — the part of a shape's outline drawn |
| `follow` | `{ pathId, progress: keys of 0..1, orient? }` — ride along another shape |
| `behaviors` | `[{ kind: shake/wiggle/float/spin/orbit/pulse, amount, period (frames), seed?, from?, to? }]` |
| `loop` | `{ from, to }` — those keys repeat |
| `motionBlur` | shutter, 0..1 of a frame |
| `progress` | `"reveal"` or `"trim"` — follows the clip's progress (bars) |
| `anchor` | `{ text, nth?, clipId?, offset? }` — timed to words, below |

A key is `{ "frame": 12, "value": …, "ease"?: … }`. `ease` shapes the move to the next key: `linear`, `ease-in`,
`ease-out`, `ease-in-out`, `back`, `elastic`, `bounce`, `hold`, or `{ "type": "bezier", "p": [x1, y1, x2, y2] }`.
Groups have tracks too: their moves, fades and behaviours carry their members.

`camera` is keys of `{ x, y, zoom }`: pan from the frame's centre, and zoom (1 = whole frame).

### Timed to the voice-over

`"anchor": { "text": "drama triangle", "offset": -3 }` moves the element's keys together so its first key lands where
those words are said in the voice clips playing during the motion clip (`clipId` names one; `nth` picks a later time
they're said; `offset` is in frames). Write the keys from frame 0; the anchor places them. It is worked out from the
voice's word timings whenever the clip plays, so recording the voice-over again re-times the animation by itself.

### Blender previs on story shots

`"shots": [ { "shot": "1.2", "previs": { "layout": "@@layout1", "depth": "@@depth1", "firstFrame": "@@first1",
"frames": 121, "source": "previs_test.blend · Cam1" } } ]` attaches a grey-box render (and optionally its depth render
and first frame) to a story shot, named by id, by its label (`"2.3"`) or by its number in story order (`3`). LTX on the
GPU then follows it as the shot's camera guide (see docs/blender-previs.md). `layout` and `depth` must be videos,
`firstFrame` a picture.

## Answers and errors

On success: `{ revision, assets: { key: assetId }, fonts: { key: family }, boards: [ids], clips: { key: clipId },
shots: [shotIds], warnings: [...] }`.

A file that doesn't fit the schema, a path outside the allowed folders, an unknown placeholder, a missing board or
frame, or an `at` pointing at a later clip answers 400 with the reason. Nothing is saved then, but media imported
before the problem was found stays in the project's library.
