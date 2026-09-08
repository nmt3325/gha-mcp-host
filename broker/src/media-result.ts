/** Native MCP media is deliberately kept out of JSON/text metadata. */
export type ImageContent = { type: "image"; data: string; mimeType: "image/png" | "image/jpeg" }
const imagesKey = Symbol("gha-mcp-image-content")
type MediaPayload = Record<string, unknown> & { [imagesKey]?: ImageContent[] }

export function withImages(payload: Record<string, unknown>, images: ImageContent[]): Record<string, unknown> {
  return Object.assign(payload, { [imagesKey]: images })
}

export function toMcpResult(payload: Record<string, unknown>) {
  const images = (payload as MediaPayload)[imagesKey] ?? []
  const metadata = Object.fromEntries(Object.entries(payload))
  const content: Array<{ type: "text"; text: string } | ImageContent> = [
    { type: "text", text: JSON.stringify(metadata) },
    ...images,
  ]
  return { content, structuredContent: metadata, ...(payload.ok === false ? { isError: true } : {}) }
}
