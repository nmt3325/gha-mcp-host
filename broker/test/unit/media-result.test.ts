import { describe, expect, it } from "vitest"
import { toMcpResult, withImages, type ImageContent } from "../../src/media-result"

describe("native MCP media boundary", () => {
  it("keeps native image bytes out of text and structured metadata", () => {
    const image: ImageContent = { type: "image", mimeType: "image/png", data: "AQID" }
    const r = toMcpResult(withImages({ ok: true, path: "test.png" }, [image]))
    expect(r.content.map(c => c.type)).toEqual(["text", "image"])
    expect(r.content[1]).toEqual(image)
    expect(r.structuredContent).toEqual({ ok: true, path: "test.png" })
    expect(r.content[0]).toEqual({ type: "text", text: '{"ok":true,"path":"test.png"}' })
  })
  it("preserves typed failures as MCP errors", () => {
    expect(toMcpResult({ ok: false, error: { code: "unsupported_image" } }).isError).toBe(true)
  })
  it("ordinary results contain only one text block", () => {
    const r = toMcpResult({ ok: true, result_pending: true })
    expect(r.content).toHaveLength(1)
    expect(r.isError).toBeUndefined()
  })
})
