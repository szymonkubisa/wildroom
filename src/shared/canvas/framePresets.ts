/** Exact pixel sizes for frames (artboards): what the web, social networks and brand files expect. */
export interface FramePreset {
  id: string
  label: string
  group: 'Web' | 'Social' | 'Ads' | 'Brand' | 'Print'
  w: number
  h: number
  /** Where it's used, shown under the label. */
  hint?: string
}

export const FRAME_PRESETS: FramePreset[] = [
  { id: 'og', label: 'Open Graph / link preview', group: 'Web', w: 1200, h: 630, hint: 'Facebook, LinkedIn, Slack, iMessage previews' },
  { id: 'x-card', label: 'X / Twitter card', group: 'Web', w: 1200, h: 675 },
  { id: 'hero', label: 'Website hero', group: 'Web', w: 1920, h: 1080 },
  { id: 'hero-wide', label: 'Website hero (wide)', group: 'Web', w: 2560, h: 1080 },
  { id: 'blog', label: 'Blog header', group: 'Web', w: 1600, h: 900 },
  { id: 'ig-post', label: 'Instagram post (4:5)', group: 'Social', w: 1080, h: 1350 },
  { id: 'ig-square', label: 'Square post', group: 'Social', w: 1080, h: 1080 },
  { id: 'story', label: 'Story / Reel / TikTok', group: 'Social', w: 1080, h: 1920 },
  { id: 'yt-thumb', label: 'YouTube thumbnail', group: 'Social', w: 1280, h: 720 },
  { id: 'yt-banner', label: 'YouTube channel art', group: 'Social', w: 2560, h: 1440 },
  { id: 'linkedin-banner', label: 'LinkedIn banner', group: 'Social', w: 1584, h: 396 },
  { id: 'x-header', label: 'X / Twitter header', group: 'Social', w: 1500, h: 500 },
  { id: 'fb-feed', label: 'Facebook / Meta feed ad', group: 'Ads', w: 1080, h: 1080 },
  { id: 'fb-link', label: 'Facebook link ad', group: 'Ads', w: 1200, h: 628 },
  { id: 'display-mrec', label: 'Display: medium rectangle', group: 'Ads', w: 300, h: 250 },
  { id: 'display-leader', label: 'Display: leaderboard', group: 'Ads', w: 728, h: 90 },
  { id: 'display-sky', label: 'Display: wide skyscraper', group: 'Ads', w: 160, h: 600 },
  { id: 'logo', label: 'Logo', group: 'Brand', w: 1024, h: 1024 },
  { id: 'app-icon', label: 'App icon', group: 'Brand', w: 1024, h: 1024, hint: 'iOS / Android / macOS master icon' },
  { id: 'favicon', label: 'Favicon master', group: 'Brand', w: 512, h: 512, hint: 'Export as a favicon pack' },
  { id: 'avatar', label: 'Profile picture', group: 'Brand', w: 800, h: 800 },
  { id: 'email-header', label: 'Email header', group: 'Brand', w: 1200, h: 400 },
  { id: 'a4', label: 'A4 portrait (150 dpi)', group: 'Print', w: 1240, h: 1754 },
  { id: 'business-card', label: 'Business card (300 dpi)', group: 'Print', w: 1050, h: 600 },
]

export const FRAME_GROUPS = ['Web', 'Social', 'Ads', 'Brand', 'Print'] as const

export function framePreset(id: string | undefined): FramePreset | undefined {
  return id ? FRAME_PRESETS.find((p) => p.id === id) : undefined
}
