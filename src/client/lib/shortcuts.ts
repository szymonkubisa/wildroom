export interface ShortcutInfo {
  keys: string
  action: string
  group: 'Playback' | 'Editing' | 'Tools' | 'View' | 'Canvas' | 'App'
}

/** Final Cut Pro–style defaults. Displayed in Settings → Shortcuts and the command palette. */
export const SHORTCUTS: ShortcutInfo[] = [
  { keys: 'Space', action: 'Play / pause', group: 'Playback' },
  { keys: 'J / K / L', action: 'Reverse / stop / forward (tap again to speed up)', group: 'Playback' },
  { keys: '← / →', action: 'Previous / next frame', group: 'Playback' },
  { keys: '⇧← / ⇧→', action: 'Back / forward 10 frames', group: 'Playback' },
  { keys: '↑ / ↓', action: 'Previous / next edit point', group: 'Playback' },
  { keys: 'Home / End', action: 'Go to start / end', group: 'Playback' },
  { keys: 'I / O', action: 'Set range start / end', group: 'Playback' },
  { keys: '⌥X', action: 'Clear range', group: 'Playback' },
  { keys: 'E', action: 'Append to storyline', group: 'Editing' },
  { keys: 'W', action: 'Insert at playhead', group: 'Editing' },
  { keys: 'Q', action: 'Connect at playhead', group: 'Editing' },
  { keys: 'D', action: 'Overwrite at playhead', group: 'Editing' },
  { keys: '⌘B', action: 'Blade at playhead', group: 'Editing' },
  { keys: '⇧⌘B', action: 'Blade all', group: 'Editing' },
  { keys: 'Delete', action: 'Ripple delete', group: 'Editing' },
  { keys: '⇧Delete', action: 'Replace with gap', group: 'Editing' },
  { keys: '⌥⌘↑', action: 'Lift from storyline', group: 'Editing' },
  { keys: '⌥⌘↓', action: 'Overwrite to primary storyline', group: 'Editing' },
  { keys: '⌃⇧S', action: 'Detach audio', group: 'Editing' },
  { keys: 'V', action: 'Enable / disable clip', group: 'Editing' },
  { keys: 'M', action: 'Add marker', group: 'Editing' },
  { keys: '⌘T', action: 'Add cross dissolve', group: 'Editing' },
  { keys: '⌃← / ⌃→', action: 'Previous / next take (audition)', group: 'Editing' },
  { keys: '⌘C / ⌘X / ⌘V', action: 'Copy / cut / paste clips at the playhead', group: 'Editing' },
  { keys: '⌥F', action: 'Freeze frame at playhead (2 s still)', group: 'Editing' },
  { keys: '⌘D', action: 'Duplicate selected clips', group: 'Editing' },
  { keys: '⌥-drag (Trim tool)', action: 'Slide a storyline clip between its neighbours', group: 'Editing' },
  { keys: '⌘Z / ⇧⌘Z', action: 'Undo / redo', group: 'Editing' },
  { keys: 'A', action: 'Select tool', group: 'Tools' },
  { keys: 'T', action: 'Trim tool', group: 'Tools' },
  { keys: 'B', action: 'Blade tool', group: 'Tools' },
  { keys: 'N', action: 'Toggle snapping', group: 'View' },
  { keys: 'S', action: 'Toggle skimming', group: 'View' },
  { keys: '⌘= / ⌘-', action: 'Zoom timeline in / out', group: 'View' },
  { keys: '⇧Z', action: 'Zoom to fit', group: 'View' },
  { keys: 'V / H', action: 'Select / hand (pan) tool', group: 'Canvas' },
  { keys: 'F / T / N / R', action: 'Draw a frame / text / note / rectangle', group: 'Canvas' },
  { keys: 'Space-drag', action: 'Pan the board', group: 'Canvas' },
  { keys: '⌥-scroll / pinch', action: 'Zoom the board', group: 'Canvas' },
  { keys: '⇧1 / ⇧2 / ⇧0', action: 'Zoom to fit / to selection / 100%', group: 'Canvas' },
  { keys: '⌘D', action: 'Duplicate selected items', group: 'Canvas' },
  { keys: '⌘C / ⌘V', action: 'Copy / paste items (paste an image to import it)', group: 'Canvas' },
  { keys: 'Arrows / ⇧Arrows', action: 'Nudge by 1 / 10 px', group: 'Canvas' },
  { keys: 'Delete', action: 'Remove selected items from the board', group: 'Canvas' },
  { keys: '⌘K', action: 'Command palette', group: 'App' },
  { keys: '⌘G', action: 'Composer (generate)', group: 'App' },
  { keys: '⌘L', action: 'Library — media, cast, places and brand', group: 'App' },
  { keys: '⌘E', action: 'Export', group: 'App' },
  { keys: '⌘I', action: 'Import media', group: 'App' },
]

/** The key event belongs to a text field, a menu or a dialog, so workspace shortcuts must leave it alone. */
export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) ||
    Boolean(target.closest('[role="dialog"], [role="menu"], [role="listbox"]'))
  )
}

/** A focused tab, radio, combobox, switch or menu item moves or toggles with Space and the arrow keys itself. */
export function ownsArrowKeys(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest('[role="tab"], [role="radio"], [role="combobox"], [role="switch"], [role="menuitem"]'))
}
