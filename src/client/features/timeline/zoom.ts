interface ZoomApi {
  zoomBy(factor: number): void
  setZoom(pxPerFrame: number): void
  zoomToFit(): void
}

let current: ZoomApi | undefined

export function registerTimelineZoom(api: ZoomApi | undefined) {
  current = api
}

export const timelineZoom = {
  in: () => current?.zoomBy(1.5),
  out: () => current?.zoomBy(1 / 1.5),
  set: (pxPerFrame: number) => current?.setZoom(pxPerFrame),
  fit: () => current?.zoomToFit(),
}
