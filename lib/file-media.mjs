/* Image input, not OCR or model inference. No application/session dependencies. */
import fs from "node:fs"
import crypto from "node:crypto"

export const IMAGE_MAX_BYTES = 4 * 1024 * 1024
export const IMAGE_MAX_PIXELS = 32_000_000
export const IMAGE_MAX_DIMENSION = 8192

const fail = (error, message, extra = {}) => ({ ok: false, error, phase: "precheck", retryable: "fix_args", message, ...extra })

/** Validate the container header and dimensions without inflating untrusted pixels. */
export function imageInfo(raw) {
  if (raw.length >= 33 && raw.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    if (raw.readUInt32BE(8) !== 13 || raw.toString("ascii", 12, 16) !== "IHDR") return null
    // Walk bounded chunks: reject truncated data, missing image data/end and APNG.
    let at = 8, data = false, end = false
    while (at + 12 <= raw.length) {
      const size = raw.readUInt32BE(at)
      if (size > raw.length - at - 12) return null
      const type = raw.toString("ascii", at + 4, at + 8)
      if (type === "acTL") return null
      if (type === "IDAT") data = true
      if (type === "IEND") { if (size !== 0) return null; end = true; break }
      at += 12 + size
    }
    if (!data || !end) return null
    return { mimeType: "image/png", width: raw.readUInt32BE(16), height: raw.readUInt32BE(20) }
  }
  if (raw.length >= 4 && raw[0] === 255 && raw[1] === 216 && raw[raw.length - 2] === 255 && raw[raw.length - 1] === 217) {
    let at = 2
    while (at + 4 <= raw.length) {
      if (raw[at++] !== 255) return null
      while (raw[at] === 255) at++
      const marker = raw[at++]
      if (marker === 218 || marker === 217) break
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue
      if (at + 2 > raw.length) return null
      const size = raw.readUInt16BE(at)
      if (size < 2 || at + size > raw.length) return null
      if ([192, 193, 194].includes(marker)) {
        if (size < 8) return null
        return { mimeType: "image/jpeg", width: raw.readUInt16BE(at + 5), height: raw.readUInt16BE(at + 3) }
      }
      at += size
    }
  }
  return null
}

export function readImage(job) {
  const pathname = String(job.path)
  let fd
  try {
    fd = fs.openSync(pathname, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0))
    const before = fs.fstatSync(fd)
    if (!before.isFile()) return fail("not_regular_file", "Image input must be a regular file")
    if (before.size > IMAGE_MAX_BYTES) return fail("image_too_large", "Resize or crop the image before reading it", { total_bytes: before.size, limit_bytes: IMAGE_MAX_BYTES })
    const raw = Buffer.alloc(before.size)
    let got = 0
    while (got < raw.length) {
      const n = fs.readSync(fd, raw, got, raw.length - got, got)
      if (!n) break
      got += n
    }
    const after = fs.fstatSync(fd)
    if (got !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      return fail("file_changed", "The image changed while it was read; read it again")
    }
    const info = imageInfo(raw)
    if (!info) return fail("unsupported_image", "Expected a complete static PNG or JPEG container; SVG, animated images and other formats are not supported")
    if (!info.width || !info.height || info.width > IMAGE_MAX_DIMENSION || info.height > IMAGE_MAX_DIMENSION || info.width * info.height > IMAGE_MAX_PIXELS) {
      return fail("image_dimensions_exceeded", "Resize or crop the image before reading it", { ...info, max_dimension: IMAGE_MAX_DIMENSION, max_pixels: IMAGE_MAX_PIXELS })
    }
    return {
      ok: true, path_as_given: job.path_as_given ?? pathname, path_resolved: pathname,
      ...info, total_bytes: raw.length, base_sha: crypto.createHash("sha256").update(raw).digest("hex"),
      transformed: false, validation: "container_header_and_dimensions",
      image: { type: "image", mimeType: info.mimeType, data: raw.toString("base64") },
    }
  } catch (error) {
    return fail(error.code === "ENOENT" ? "not_found" : "image_read_failed", "Could not read the requested image", { errno: error.code ?? null })
  } finally { if (fd !== undefined) fs.closeSync(fd) }
}
