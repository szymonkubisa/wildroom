import type { Workspace } from '@/stores/editor'
/**
 * Everything the app can do, in one place: the Features page lists it and the walkthrough tours it.
 * `tour` links a feature to the walkthrough step that shows where it lives.
 */

export type Needs = 'ElevenLabs' | 'Anthropic' | 'OpenRouter' | 'Kling' | 'fal.ai'

export interface Feature {
  id: string
  title: string
  summary: string
  /** Where to find it / how to use it. */
  how: string
  shortcut?: string
  /** Providers that make it work for real (most features also run free in demo mode). */
  needs?: Needs[]
  /** Walkthrough step that shows it. */
  tour?: string
  isNew?: boolean
}

export interface FeatureGroup {
  id: string
  title: string
  blurb: string
  features: Feature[]
}

export const FEATURE_GROUPS: FeatureGroup[] = [
  {
    id: 'canvas',
    title: 'Create & brand',
    blurb: 'Brand identity, web and social assets on an infinite board — next to the films, in the same project.',
    features: [
      { id: 'workspaces', title: 'Plan · Create · Edit', summary: 'Plan, Create and Edit share one project; the Library holds its media, cast, places and brand kit.', how: 'Left rail. Pick where a new project starts in the New project dialog — Film starts in Plan.', tour: 'story' },
      { id: 'library', title: 'Library', summary: 'One panel on the left of Plan, Create and Edit: Media, Cast, Places and Brand.', how: 'Rail → Library, or ⌘L. Drag media onto the timeline, the board or a slot; on a character or place, Design look or Use in prompt.', shortcut: '⌘L', tour: 'library' },
      { id: 'canvas-board', title: 'Infinite canvas', summary: 'Drop, paste and arrange images, notes, text and shapes on boards.', how: 'Create in the left rail. Drop files or drag from the media browser; V/H/F/T/N/R tools, ⇧1 to fit.', tour: 'canvas' },
      { id: 'canvas-generate', title: 'Generate from the selection', summary: 'Selected images become references; the result lands next to them, linked.', how: 'Select images on the board — the Composer at the bottom offers “Use the selected images”. Select a frame to fill it at its exact size.', tour: 'canvas' },
      { id: 'frames', title: 'Frames of exact sizes', summary: 'OG image, Instagram, story, YouTube thumbnail, ads, favicon and more.', how: 'Board toolbar in Create → Frame, or right-click the board → Add frame. Export frames as PNG, JPEG or WebP at 1–3×.' },
      { id: 'cutout', title: 'Remove background & vectorize', summary: 'One click: the subject on transparency, or a clean SVG of a logo.', how: 'Right-click an image on the board → Remove background / Vectorize to SVG.', needs: ['fal.ai'] },
      { id: 'favicon', title: 'Favicon & app icon pack', summary: 'favicon.ico, Apple and Android icons, web manifest and the HTML to paste.', how: 'Select an image or frame → right-click → Favicon & app icons…' },
      { id: 'brand-kit', title: 'Brand kit', summary: 'Palette (extracted from your logo), fonts, logos, style and voice.', how: 'Library › Brand (⌘L). With “Use the look in every generation” on — the same switch as the Look chip in the Composer — prompts follow the style and palette and use the style images as references.', tour: 'library' },
      { id: 'text-models', title: 'Choose the AI Director’s model', summary: 'Claude, GPT, Gemini, DeepSeek or any OpenRouter text model for scripts, briefs and prompt help.', how: 'Settings → Director, or the “Director:” picker in Plan › Script and in the look designer.', needs: ['OpenRouter'] },
      { id: 'openrouter-images', title: 'Image models via OpenRouter', summary: 'GPT Image 2.5, Nano Banana, Seedream 5, FLUX.3, Recraft, Grok Imagine — or any image model OpenRouter lists — on one key.', how: 'Generate → Image → the OpenRouter group in the model menu. “Any OpenRouter image model” shows each model’s price and what it takes. Presets use them when fal.ai isn’t connected.', needs: ['OpenRouter'], tour: 'generate' },
      { id: 'brief', title: 'Brief → asset set', summary: 'Describe the brand or campaign; the AI Director plans a matching set and the canvas generates it.', how: 'Board toolbar in Create → Brief. Review prompts and copy, then generate — copy lands as editable text on each frame.', needs: ['Anthropic', 'OpenRouter', 'fal.ai'] },
    ],
  },
  {
    id: 'start',
    title: 'Getting started',
    blurb: 'Projects, keys and the fastest way to any command.',
    features: [
      { id: 'projects', title: 'Projects', summary: 'Each film is a project with its own timeline, story and media.', how: 'Home screen → New project. Film starts in Plan, Edit footage in Edit; pick a format (1080p, vertical 9:16, square, 4K) — the frame rate locks to your first clip.', tour: 'welcome' },
      { id: 'home-start', title: 'Start from a sentence', summary: 'Say what you are making; a film or ad opens in Plan with the Director writing its script, scenes and shots, then proposing what to generate.', how: 'Home → “What are we making?” → pick Film, Ad, Social post or Edit footage → Start (⌘↵). Nothing is rendered until you approve the plan.' },
      { id: 'director-chat', title: 'Ask the Director', summary: 'A chat beside Plan, Create and Edit: ask for stills, takes, a golden-hour scene, a shorter cut or music, and get a plan with each step’s cost and time.', how: 'Top bar → Director, ⌘D, or ⌘K → Ask the Director. Approve & run starts the plan (nothing is generated before); Change something or Not now leaves it.', shortcut: '⌘D', needs: ['Anthropic', 'OpenRouter', 'fal.ai'] },
      { id: 'project-tags', title: 'Find, tag and pin projects', summary: 'Search names, tags and status; filter by kind and tags; sort; grid or list; pinned first.', how: 'Home → Projects. Tags and Pin are in each project’s ⋯ menu; tags are kept in the project folder.' },
      { id: 'settings-search', title: 'Settings over your work', summary: 'Settings opens as a sheet over the project, with one search across every tab.', how: 'Rail → Settings, or ⌘,. Type to find a setting in any tab.', shortcut: '⌘,' },
      { id: 'demo', title: 'Demo mode', summary: 'Try every workflow for free with local stand-in generators.', how: 'Settings → General → Demo mode. Demo models are marked “Free”.' },
      { id: 'providers', title: 'Provider keys', summary: 'Connect ElevenLabs, Kling, fal.ai and Anthropic. Keys live in the macOS Keychain.', how: 'Settings → Providers → paste a key → Test.' },
      { id: 'palette', title: 'Command palette', summary: 'Search and run any command without hunting through menus.', how: 'Top bar → Commands.', shortcut: '⌘K', tour: 'commands' },
      { id: 'shortcuts', title: 'Final Cut–style shortcuts', summary: 'J/K/L, I/O, E/W/Q/D, blade, trim and more.', how: 'Settings → Shortcuts lists them all.' },
    ],
  },
  {
    id: 'media',
    title: 'Media & library',
    blurb: 'Bring footage in, find it again, keep it organised.',
    features: [
      { id: 'import', title: 'Import media', summary: 'Video, audio and images; proxies, waveforms and filmstrips are made automatically.', how: 'Drop files on the Assets panel or press Import.', shortcut: '⌘I', tour: 'assets' },
      { id: 'skim', title: 'Skim & preview', summary: 'Hover over a thumbnail to skim it in the viewer.', how: 'Assets panel. Toggle skimming with S.', shortcut: 'S', tour: 'assets' },
      { id: 'ratings', title: 'Favourite & reject', summary: 'Mark the good takes; hide rejects.', how: 'Right-click media in Assets → Favorite / Reject. The filter menu shows favourites only.', tour: 'assets' },
      { id: 'search', title: 'Plain-language search', summary: 'Find media by what is in the shot, what is said in it, its prompt or keywords.', how: 'Type in the Assets search, e.g. “night street rain” or a line of dialogue. The card shows why it matched.', tour: 'search' },
      { id: 'describe', title: 'Describe with AI', summary: 'A vision model looks at the frames and writes a searchable description and tags.', how: 'Right-click media → Describe with AI, or Filter menu → Describe all media with AI.', needs: ['Anthropic', 'OpenRouter'], tour: 'search' },
      { id: 'keywords', title: 'Keywords', summary: 'Tag media and filter by tag with one click.', how: 'Right-click media → Keywords… (works on a multi-selection). Keyword chips appear under the search.', tour: 'collections' },
      { id: 'collections', title: 'Smart collections', summary: 'Save any search or filter and come back to it in one click.', how: 'Assets → bookmark button → Save current filter…', tour: 'collections' },
    ],
  },
  {
    id: 'generate',
    title: 'Generate',
    blurb: 'Shots, images, voices, music and sound — straight into the edit.',
    features: [
      { id: 'models', title: 'Video, image & audio models', summary: 'Kling 3.0, Veo 3.1, Seedance, Wan, GPT Image 2.5, Nano Banana, Seedream, FLUX, ElevenLabs voices, music and SFX, and more.', how: 'Right panel → Generate. Pick a kind (Video, Image, Voice, Dialogue, Music, SFX, Lip-sync, Foley, Upscale) and a model — the menu groups them by provider.', shortcut: '⌘G', needs: ['Kling', 'fal.ai', 'OpenRouter', 'ElevenLabs'], tour: 'generate' },
      { id: 'local-ltx', title: 'Local video (LTX-2.5)', summary: 'Generate video on this Mac for free and in private — nothing is uploaded. Audio and start/end frames included.', how: 'Install once with pnpm models:ltx (Settings → Providers → LTX-2.5 on this Mac shows its status), then pick “LTX-2.5 (this Mac)” in the Composer’s model menu (Video). Expect several minutes per clip on a 16 GB Mac.', tour: 'generate' },
      { id: 'takes', title: 'Takes (auditions)', summary: 'Generate several variants into one timeline clip and flip between them in place.', how: 'Choose 1–4 takes before Generate. On the timeline press ⌃← / ⌃→, or pick a take in the Inspector.', shortcut: '⌃← / ⌃→', tour: 'inspector' },
      { id: 'frames', title: 'Start & end frames', summary: 'Animate from an image, or make a shot land on an exact final frame.', how: 'Generate → Start frame / End frame: drop an image, upload one, or grab the frame at the playhead.', tour: 'generate' },
      { id: 'camera', title: 'Camera moves', summary: 'One-click camera language: push-in, orbit, crane, FPV, dolly zoom and more.', how: 'Generate → Camera move under the video prompt: animated tiles, worded for the selected model (LTX, Veo, Kling, Seedance); the camera menu on story shot cards.', tour: 'generate' },
      { id: 'enhance', title: 'Prompt enhance', summary: 'The AI Director rewrites your prompt with lens, lighting and motion detail.', how: 'Generate → Enhance above the prompt.', needs: ['Anthropic', 'OpenRouter', 'fal.ai'], tour: 'generate' },
      { id: 'here', title: 'Generate on the timeline', summary: 'A placeholder appears where you want the shot and fills in when it is ready.', how: 'In Edit, the Composer puts its result at the playhead (click where it goes, at the top right of the Composer, to send it to the Library only). Or right-click an empty spot on the timeline → Generate shot here…', tour: 'timeline' },
      { id: 'jobs', title: 'Activity', summary: 'Everything you generate joins one queue in Activity: reorder it, pause it, see live progress, time left and when each local render starts.', how: 'Top bar → Activity. Pause to hold new jobs (running ones finish); cloud jobs run one at a time unless you switch that off.', tour: 'jobs' },
      { id: 'history', title: 'Activity history', summary: 'Every past render with its full prompt, model, all settings, input frames, render time and cost.', how: 'Top bar → Activity → History. Search, then Use these settings to load a render back into Generate, or Render again.', tour: 'jobs' },
      { id: 'voicelab', title: 'Voice Lab', summary: 'Design a new voice from a description, or clone one from a recording.', how: 'Generate → Voice → voice picker → Voice Lab.', needs: ['ElevenLabs'], tour: 'generate' },
    ],
  },
  {
    id: 'story',
    title: 'Plan',
    blurb: 'From a script to an assembled first cut.',
    features: [
      { id: 'director', title: 'AI Director', summary: 'Paste a script or an idea; get characters and a shot list with prompts, dialogue and SFX.', how: 'Plan in the left rail → Script: write the script (or an idea) → Create scenes; each scene’s shots are written in Shots. Edited the script later? Update scenes rewrites only the scenes that changed. Pick the model in Settings → Director.', needs: ['Anthropic', 'OpenRouter', 'fal.ai'], tour: 'story' },
      { id: 'cast', title: 'Cast & consistent characters', summary: 'Each character has a look, reference images and a voice; sync them to Kling elements so they stay the same across shots.', how: 'Plan → Cast & Places → Cast.', needs: ['Kling', 'ElevenLabs'], tour: 'story' },
      { id: 'places', title: 'Places & consistent locations', summary: 'Each location has a look and up to four photos; a shot’s still uses its place’s photos together with the cast’s references.', how: 'Plan → Cast & Places → Places → add a place and its photos, then pick it for a scene or a shot.', tour: 'story' },
      { id: 'batch', title: 'Batch generation', summary: 'Stills, voices and takes for every shot, with a cost check first.', how: 'Plan → a scene → Stills & voices, then Animate scene (or Render for the whole film).', tour: 'story' },
      { id: 'assemble', title: 'Update timeline', summary: 'Puts the chosen takes (else stills) and the dialogue on the “Story cut” timeline in script order — replaced as a whole each time, in one undo step; other timelines are never touched.', how: 'Plan → Film → Update timeline (the animatic goes on the Story cut too).', tour: 'story' },
    ],
  },
  {
    id: 'timeline',
    title: 'Timeline editing',
    blurb: 'A magnetic, Final Cut–style timeline.',
    features: [
      { id: 'magnetic', title: 'Magnetic storyline', summary: 'Clips close gaps automatically; titles, music and B-roll connect to the picture and move with it.', how: 'Drag media onto the timeline: the middle row is the storyline, above and below are connected clips.', tour: 'timeline' },
      { id: 'edits', title: 'Append / insert / connect / overwrite', summary: 'Put selected media on the timeline from the keyboard.', how: 'Select in Assets, then E, W, Q or D.', shortcut: 'E W Q D', tour: 'timeline' },
      { id: 'tools', title: 'Select, trim & blade', summary: 'Ripple trim, roll edits, slip and blade.', how: 'Timeline toolbar or A / T / B. With the Trim tool: drag an edge to roll, the body to slip.', shortcut: 'A T B', tour: 'timeline-tools' },
      { id: 'slide', title: 'Slide', summary: 'Move a clip between its neighbours without changing the length of the film.', how: 'Trim tool → ⌥-drag the clip.', shortcut: '⌥-drag', tour: 'timeline-tools' },
      { id: 'clipboard', title: 'Copy, paste & duplicate', summary: 'Copy clips (with their offsets and lanes) and paste them at the playhead.', how: 'Select clips → ⌘C / ⌘X, move the playhead, ⌘V. ⌘D duplicates right after.', shortcut: '⌘C ⌘V ⌘D', tour: 'timeline' },
      { id: 'snapping', title: 'Snapping & skimming', summary: 'Edges, markers, the playhead and music beats attract.', how: 'N toggles snapping, S toggles skimming.', shortcut: 'N / S', tour: 'timeline-tools' },
      { id: 'markers', title: 'Markers', summary: 'Standard, to-do and chapter markers that stay on the picture.', how: 'M at the playhead.', shortcut: 'M', tour: 'timeline' },
      { id: 'transitions', title: 'Transitions', summary: 'Cross dissolve, dip to black or white — no handles needed.', how: '⌘T at an edit point; change type and length in the Inspector.', shortcut: '⌘T', tour: 'inspector' },
      { id: 'titles', title: 'Titles & solids', summary: 'Basic, centred, lower-third and caption titles with animations.', how: 'Timeline toolbar → Title, or the command palette.', tour: 'timeline-tools' },
      { id: 'split', title: 'Split into shots', summary: 'Scene detection cuts a long generated clip into its shots.', how: 'Right-click a video clip → Split into shots.', tour: 'timeline' },
      { id: 'storyline', title: 'Lift / overwrite, detach audio', summary: 'Move clips between the storyline and connected lanes; split sound from picture.', how: '⌥⌘↑ / ⌥⌘↓, ⌃⇧S.', shortcut: '⌥⌘↑ ⌥⌘↓ ⌃⇧S', tour: 'timeline' },
    ],
  },
  {
    id: 'clip',
    title: 'Clip look & motion',
    blurb: 'Everything in the Inspector.',
    features: [
      { id: 'transform', title: 'Transform & crop', summary: 'Scale, position, rotation, crop, fit/fill.', how: 'Select a clip → Inspector → Video.', tour: 'inspector' },
      { id: 'keyframes', title: 'Keyframes with easing', summary: 'Animate opacity, scale, position and rotation; linear, ease-in/out or hold.', how: 'Inspector → ◇ next to Opacity or Transform adds a key at the playhead; move the playhead and change a value to add the next. Diamonds show on the clip.', tour: 'inspector' },
      { id: 'effects', title: 'Effects', summary: 'Colour, colour balance, black & white, sepia, blur, vignette, film grain, letterbox.', how: 'Inspector → Effects → Add.', tour: 'inspector' },
      { id: 'match', title: 'Match colour', summary: 'Grades a shot to look like another one.', how: 'Inspector → Tools → Match colour, or right-click → Clip tools → Match colour to previous/next shot.', tour: 'inspector' },
      { id: 'speed', title: 'Speed, freeze & reverse', summary: 'Retime 25–400 %, hold a frame for 2 s, or play backwards.', how: 'Inspector → Speed; ⌥F freezes the frame at the playhead; Clip tools → Reverse.', shortcut: '⌥F', tour: 'inspector' },
    ],
  },
  {
    id: 'ai-edit',
    title: 'AI editing',
    blurb: 'Generation that understands the edit around it.',
    features: [
      { id: 'extend', title: 'Generative extend', summary: 'A shot too short? Generate more after its last frame, or a lead-in that ends exactly on its first frame.', how: 'Right-click a video clip → Generate more after the last frame / before the first frame (also in Inspector → Tools). Or drag a clip’s right edge past its media (“Release to generate”). “Before” takes two steps: an earlier frame, then the video into the clip.', tour: 'timeline' },
      { id: 'fill', title: 'Fill a gap', summary: 'Generates a bridging shot that starts on the previous clip’s last frame and ends on the next clip’s first.', how: 'Right-click a gap → Fill gap with a generated shot.', tour: 'timeline' },
      { id: 'edit-inside', title: 'Edit inside a shot', summary: 'Mark an area and describe the change (remove, replace, recolour, add); the shot is re-generated as a new take.', how: 'AI tools → Edit inside the shot, with the playhead over the shot.', tour: 'ai-tools' },
      { id: 'continuity', title: 'Continuity check', summary: 'A vision model compares both sides of every cut for wardrobe, prop, lighting and colour changes, and suggests a prompt fix.', how: 'AI tools → Check continuity.', needs: ['Anthropic', 'OpenRouter'], tour: 'ai-tools' },
      { id: 'reframe', title: 'Smart reframe', summary: 'A vertical, square or 4:5 copy of the project where every shot follows its subject.', how: 'AI tools → Smart reframe.', needs: ['Anthropic', 'OpenRouter'], tour: 'ai-tools' },
      { id: 'newtake', title: 'New take, upscale, lip-sync', summary: 'Regenerate a clip, upscale it, or sync lips to new dialogue — the result becomes another take.', how: 'Right-click a clip → Generate new take / Upscale; Generate → Lip-sync.', needs: ['fal.ai'], tour: 'timeline' },
    ],
  },
  {
    id: 'audio',
    title: 'Sound',
    blurb: 'Dialogue, music and effects that mix themselves.',
    features: [
      { id: 'mixer', title: 'Roles & mixer', summary: 'Dialogue, music and effects buses with gain, mute and solo.', how: 'Timeline toolbar → Mixer.', tour: 'captions-mixer' },
      { id: 'ducking', title: 'Auto-ducking & dialogue levelling', summary: 'Music dips under speech; every line is brought to the same loudness.', how: 'Mixer → Ducking / Normalise dialogue.', tour: 'captions-mixer' },
      { id: 'volume', title: 'Volume keyframes & fades', summary: 'Rubber-band volume and fade handles right on the clip.', how: 'Drag the volume line; ⌥-click it to add a key; drag the round handles for fades.', tour: 'timeline' },
      { id: 'isolate', title: 'Isolate voice', summary: 'Removes background noise and music from speech.', how: 'Right-click → Clip tools → Isolate voice, or Inspector → Tools.', needs: ['ElevenLabs'], tour: 'inspector' },
      { id: 'beats', title: 'Beat detection', summary: 'Finds the beats in music; cuts snap to them.', how: 'Right-click a music clip → Clip tools → Detect beats. Ticks appear on the clip.', tour: 'timeline' },
      { id: 'sfx', title: 'Foley & sound effects', summary: 'Generate sound from a prompt, or from the video itself.', how: 'Generate → SFX / Foley.', needs: ['ElevenLabs', 'fal.ai'], tour: 'generate' },
    ],
  },
  {
    id: 'speech',
    title: 'Speech & captions',
    blurb: 'Edit the film like a document.',
    features: [
      { id: 'transcribe', title: 'Transcribe speech', summary: 'Word-accurate transcripts of any clip, with speakers.', how: 'Right-click a clip → Clip tools → Transcribe speech, or Transcript tab → Transcribe.', needs: ['ElevenLabs'], tour: 'transcript' },
      { id: 'text-edit', title: 'Edit by transcript', summary: 'Select words and press Delete — the timeline is cut to match.', how: 'Right panel → Transcript. Click a word to jump there, ⇧-click to select a range.', tour: 'transcript' },
      { id: 'fillers', title: 'Remove fillers & long pauses', summary: 'One click cuts every “um”, “uh” and dead air.', how: 'Transcript → Fillers / Long pauses.', tour: 'transcript' },
      { id: 'captions', title: 'Captions', summary: 'Timed captions from dialogue or transcripts; burn in or export SRT/VTT.', how: 'Timeline toolbar → Captions.', tour: 'captions-mixer' },
    ],
  },
  {
    id: 'export',
    title: 'Export',
    blurb: 'Finish and hand off.',
    features: [
      { id: 'export', title: 'Export video', summary: 'H.264 or HEVC MP4 with loudness normalisation (−14/−16/−23 LUFS) and optional burned-in captions.', how: 'Top bar → Export.', shortcut: '⌘E', tour: 'export' },
      { id: 'fcpxml', title: 'Final Cut Pro XML', summary: 'Continue the edit in Final Cut Pro.', how: 'Command palette → Export for Final Cut Pro.', tour: 'export' },
    ],
  },
]

export const ALL_FEATURES = FEATURE_GROUPS.flatMap((g) => g.features)

// ---------------------------------------------------------------------------------------------------------------
// Walkthrough

export type TourRoute = 'projects' | 'editor' | 'settings'

export interface TourStep {
  id: string
  route: TourRoute
  /** `[data-tour="…"]` target; omitted = centred card. */
  target?: string
  title: string
  body: string
  /** Editor UI state to set before showing the step. */
  rightTab?: 'inspector' | 'transcript'
  workspace?: Workspace
}

export const TOUR_STEPS: TourStep[] = [
  {
    id: 'welcome',
    route: 'editor',
    workspace: 'edit',
    title: 'Welcome to Wildroom',
    body: 'A film studio in one window: generate shots, voices and music, then cut them on a Final Cut–style timeline. This tour shows where everything is — about two minutes. Use → / ← or the buttons; Esc ends it.',
  },
  { id: 'assets', route: 'editor', target: 'assets', workspace: 'edit', title: 'Assets', body: 'Everything you import or generate lands here. Drop files in, hover a thumbnail to skim it, right-click for actions: append, animate, extend, favourite, keywords, describe with AI.' },
  { id: 'search', route: 'editor', target: 'assets-search', workspace: 'edit', title: 'Search in plain words', body: 'Search matches names, prompts, keywords, AI descriptions and even what is said in a clip. Try “sunset beach” or a line of dialogue — the card tells you why it matched.' },
  { id: 'collections', route: 'editor', target: 'assets-collections', workspace: 'edit', title: 'Keywords & smart collections', body: 'Save the current search or filter as a smart collection. Keyword chips under the search filter with one click; add keywords from the right-click menu.' },
  { id: 'viewer', route: 'editor', target: 'viewer', workspace: 'edit', title: 'Viewer', body: 'Plays the timeline, or the media you are skimming. Space plays, J/K/L shuttle, ← / → step frames, ↑ / ↓ jump between edits.' },
  { id: 'generate', route: 'editor', target: 'composer', workspace: 'edit', title: 'Composer', body: 'One prompt bar under the viewer — the same at the bottom of Create (in Plan, an open shot has its own prompts). Pick Image, Video, Audio or Tools, type @ to bring in a character, place or the brand look, and leave the model on Auto (it follows what you attach) or pick one with its cost and time. The tiles above the prompt hold the pictures it takes (frames; References, picked from what was generated, uploaded, the cast and places or the favourites) and the look — Camera (framing and lens), Lighting and Color, each Auto until picked; the cost and wait show before Generate (⌘↵), and the top right says where the result goes — here, the timeline at the playhead.' },
  { id: 'inspector', route: 'editor', target: 'right-panel', workspace: 'edit', rightTab: 'inspector', title: 'Inspector', body: 'Select a clip to edit it here: takes, transform with keyframes and easing, effects, match colour, speed, freeze, reverse, voice isolation and transitions.' },
  { id: 'transcript', route: 'editor', target: 'right-panel', workspace: 'edit', rightTab: 'transcript', title: 'Transcript', body: 'Edit by text: every spoken word on the timeline appears here. Select words and press Delete to cut them, or remove all fillers and long pauses in one click.' },
  { id: 'timeline', route: 'editor', target: 'timeline', workspace: 'edit', title: 'Magnetic timeline', body: 'The middle row is the storyline; connected clips sit above and below and move with the picture. Right-click an empty spot to generate a shot there, a gap to fill it, a clip for its tools. Drag a video clip’s end past its media to generate a continuation.' },
  { id: 'timeline-tools', route: 'editor', target: 'timeline-toolbar', workspace: 'edit', title: 'Tools', body: 'Select (A), Trim (T) and Blade (B). With Trim: drag an edge to roll, the body to slip, ⌥-drag to slide. Also undo/redo, titles, markers and snapping (N).' },
  { id: 'captions-mixer', route: 'editor', target: 'captions-mixer', workspace: 'edit', title: 'Captions & mixer', body: 'Captions come from dialogue and transcripts — burn them in or export SRT. The mixer has dialogue, music and effects buses with automatic music ducking under speech.' },
  { id: 'ai-tools', route: 'editor', target: 'ai-tools', title: 'AI tools', body: 'Edit inside a shot (remove, replace, recolour), check continuity between shots, and make vertical or square versions that follow each shot’s subject.' },
  { id: 'story', route: 'editor', target: 'workspace', title: 'Plan · Create · Edit', body: 'The left rail switches what you make in this project, in the order a film is made: Plan (script → cast & places → each scene’s shots, stills and takes), Create (images, web and social assets on an infinite board) and Edit (this editor — generations land at the playhead).' },
  { id: 'library', route: 'editor', target: 'library', title: 'Library', body: 'One panel on the left of Plan, Create and Edit (⌘L): Media (search, skim, drag onto the timeline or the board), Cast and Places (design a look, or @mention one in the Composer) and Brand (colours, fonts, logos and style — with its switch on, every image and video generation follows it).' },
  { id: 'canvas', route: 'editor', target: 'canvas', workspace: 'canvas', title: 'Create', body: 'Drop or paste images, add frames of exact sizes (OG image, Instagram, story, favicon…), then select images and generate — they become the references and the result lands next to them, linked. Right-click to remove a background, vectorize, animate or use an image in the video.' },
  { id: 'commands', route: 'editor', target: 'commands', title: 'Command palette', body: 'Forgot where something is? ⌘K searches every command — generation, editing, AI tools and views.' },
  { id: 'jobs', route: 'editor', target: 'jobs', title: 'Activity', body: 'Every Generate joins one queue here and runs in order — reorder or pause it, and see time left. History keeps each render\'s prompt, model and settings so you can reuse them. In Edit, results also land on the timeline at the playhead.' },
  { id: 'export', route: 'editor', target: 'export', title: 'Export', body: 'MP4 with loudness normalisation and optional burned-in captions — or Final Cut Pro XML from the command palette.' },
  {
    id: 'done',
    route: 'editor',
    title: 'You are ready',
    body: 'Every feature, with how to use it, is listed on the Features page (home screen → Features, or Settings → Help). You can restart this tour from there any time.',
  },
]
