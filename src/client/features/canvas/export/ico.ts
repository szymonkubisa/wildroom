/** One image of an icon: PNG bytes and its square size in pixels (1–256). */
export interface IcoImage {
  size: number
  png: Uint8Array
}

/**
 * A Windows .ico holding PNG images (supported by every browser and Windows Vista+): a 6-byte header, a 16-byte
 * directory entry per image, then the PNGs back to back.
 */
export function encodeIco(images: IcoImage[]): Uint8Array<ArrayBuffer> {
  const headerSize = 6 + images.length * 16
  const total = headerSize + images.reduce((n, i) => n + i.png.length, 0)
  const out = new Uint8Array(new ArrayBuffer(total))
  const view = new DataView(out.buffer)
  view.setUint16(0, 0, true) // reserved
  view.setUint16(2, 1, true) // type: icon
  view.setUint16(4, images.length, true)
  let offset = headerSize
  images.forEach((img, i) => {
    if (img.size < 1 || img.size > 256) throw new Error(`Icon size ${img.size} is out of range`)
    const entry = 6 + i * 16
    view.setUint8(entry, img.size === 256 ? 0 : img.size) // width (0 = 256)
    view.setUint8(entry + 1, img.size === 256 ? 0 : img.size) // height
    view.setUint8(entry + 2, 0) // palette colours
    view.setUint8(entry + 3, 0) // reserved
    view.setUint16(entry + 4, 1, true) // colour planes
    view.setUint16(entry + 6, 32, true) // bits per pixel
    view.setUint32(entry + 8, img.png.length, true)
    view.setUint32(entry + 12, offset, true)
    out.set(img.png, offset)
    offset += img.png.length
  })
  return out
}
