import {
  addMarker,
  appendToSpine,
  bladeAt,
  connectAt,
  detachAudio,
  duplicate,
  insertAt,
  liftFromStoryline,
  moveAcross,
  moveMarker,
  overwriteAt,
  overwriteToPrimary,
  removeMarker,
  replaceWithGap,
  resolveGeneration,
  rippleDelete,
  roll,
  setSpeed,
  slide,
  slip,
  trimEdge,
  updateMarker,
} from './compound'
import { audition, blade, connect, insert, move, remove, setProps, setRange, setTransition } from './primitives'

export type * from './types'
export { absolutePositions, applyOp, normalizeDoc } from './apply'
export { normalize } from './normalize'
export {
  anchorAt,
  anchoredFrame,
  clipsAt,
  compareComposite,
  defaultLaneFor,
  indexSpine,
  layoutTimeline,
  localFrameAt,
  ownerAt,
  sourceTimeAt,
  spineGeometry,
} from './layout'
export type { Anchor, SpineGeometry, SpineIndex } from './layout'
export { collectSnapPoints, snapFrame } from './snapping'
export type { SnapPointOptions, SnapResult } from './snapping'
export {
  DEFAULT_TITLE_STYLE,
  STILL_DEFAULT_SECONDS,
  makeGap,
  makeGenerator,
  makeMediaClip,
  makeMotion,
  makeTitle,
} from './factories'
export type { MakeGeneratorInput, MakeMediaClipInput, MakeMotionInput, MakeTitleInput } from './factories'
export { PROJECT_FPS_OPTIONS, nearestProjectFps } from './fps'
export { MAX_SPEED, MIN_SPEED } from './util'
export type { ConnectableClip } from './util'
export { primitives } from './primitives'
export type { PrimitiveOptions } from './primitives'
export { overwriteRange } from './compound'
export { copyEntries, pasteClips, replaceGap, rippleDeleteRange } from './editing'
export type { ClipboardEntry } from './editing'
export { adjacentKey, cubicBezier, ease, keyAt, keyframeObject, keyframeValue, removeKey, sortKeys, upsertKey } from './keyframes'

export {
  addMarker,
  appendToSpine,
  audition,
  blade,
  bladeAt,
  connect,
  connectAt,
  detachAudio,
  duplicate,
  insert,
  insertAt,
  liftFromStoryline,
  move,
  moveAcross,
  moveMarker,
  overwriteAt,
  overwriteToPrimary,
  remove,
  removeMarker,
  replaceWithGap,
  resolveGeneration,
  rippleDelete,
  roll,
  setProps,
  setRange,
  setSpeed,
  setTransition,
  slide,
  slip,
  trimEdge,
  updateMarker,
}

/** Every op factory, for `applyOp(doc, ops.bladeAt(120), ctx)`. */
export const ops = {
  // primitives
  insert,
  remove,
  setRange,
  blade,
  connect,
  move,
  setProps,
  setTransition,
  audition,
  // editor ops
  appendToSpine,
  insertAt,
  connectAt,
  overwriteAt,
  bladeAt,
  rippleDelete,
  replaceWithGap,
  trimEdge,
  roll,
  slip,
  slide,
  liftFromStoryline,
  overwriteToPrimary,
  moveAcross,
  setSpeed,
  detachAudio,
  addMarker,
  moveMarker,
  removeMarker,
  updateMarker,
  duplicate,
  resolveGeneration,
} as const
