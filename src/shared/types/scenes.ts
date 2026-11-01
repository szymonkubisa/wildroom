/** `POST /api/assets/:id/scene-cuts` — shot boundaries inside a video asset. */
export interface SceneCutsRequest {
  /**
   * Where the shots are expected to change (seconds from the asset's t=0), e.g. from a multi-shot prompt.
   * Omitted: the Kling multi-shot plan stored on the asset is used, if any.
   */
  expected?: number[]
  /** Scene score threshold 0–1 (default 0.3). */
  threshold?: number
  /** How far (seconds) an expected cut may move to meet a detected one (default 0.5). */
  tolerance?: number
}

export interface SceneCutsResponse {
  /** Seconds from the asset's t=0 (= proxy t=0), sorted, strictly inside the clip. */
  cuts: number[]
  /**
   * `detected`: no expected cuts — scene detection only. `refined`: expected cuts, at least one snapped to a
   * detected cut. `expected`: expected cuts unchanged (nothing detected nearby, or detection failed).
   */
  source: 'detected' | 'refined' | 'expected'
  /** Raw scene detection result (empty when detection failed). */
  detected: number[]
}
