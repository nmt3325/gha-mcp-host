import { withImages, type ImageContent } from "./media-result"
import { Deadline, clamp, fail, makePollClock, numArg, ok } from "./result"
import { type Bindings, envStub, platformOf, tryCall } from "./tools-shared"
import type { ToolCtx } from "./mcp"

const TERMINAL = new Set(["exited", "killed", "lost"])
const WINDOW = 262_144
const MAX_RESULT = 8 * 1024 * 1024
const MAX_IMAGE_B64 = Math.ceil(4 * 1024 * 1024 / 3) * 4
const bytes = (b64: string) => Uint8Array.from(atob(b64), c => c.charCodeAt(0))

/** Reassemble on the server, never expose image/base64 fragments to a model. */
export async function collectFileResult(
  env: Bindings, envId: string, commandId: string, deadlineMs: unknown,
  ctx: ToolCtx, expectedOp?: string, warnings: string[] = [],
): Promise<Record<string, unknown>> {
  const stub = envStub(env, envId)
  const dl = new Deadline(clamp(numArg(deadlineMs, 20_000), 0, 45_000), ctx.signal)
  const clock = makePollClock(150, 1000)
  const started = Date.now()
  const common = { env_id: envId, command_id: commandId, platform: platformOf(envId) }
  let w: any = null
  const pending = () => ok({ ...common, op: expectedOp ?? null, state: w?.state ?? "queued", still_running: !TERMINAL.has(w?.state), result_pending: true, elapsed_ms: Date.now() - started }, {
    warnings, hint: "The original job still owns this result. Retrieve it; do not resubmit the operation.",
    next_action: `file_result(env_id: "${envId}", command_id: "${commandId}")`,
  })
  do {
    const r = await tryCall(() => stub.window(commandId, 0, WINDOW))
    if (r.value) w = r.value
    if (w && !w.found) return fail("bad_input", "No such file job in this environment", { extra: common })
    if (w && TERMINAL.has(w.state)) break
    ctx.note("waiting for the original file job")
  } while (await dl.tick(clock.next()))
  if (!w || !TERMINAL.has(w.state)) return pending()
  if (w.state === "lost") return fail("lost", "The runner stopped before reporting the file result; verify files before repeating a write", { extra: { ...common, state: w.state } })
  const total = Number(w.total_bytes)
  if (!Number.isSafeInteger(total) || total < 1 || total > MAX_RESULT) return fail("file_result_unavailable", "File result is empty or exceeds its bounded retrieval limit", { extra: { ...common, total_bytes: total, limit_bytes: MAX_RESULT }, hint: "Inspect the original job; do not blindly repeat a mutation" })
  const output = new Uint8Array(total)
  let at = 0
  while (at < total) {
    if (at > 0) {
      if (dl.expired) return pending()
      const r = await tryCall(() => stub.window(commandId, at, WINDOW))
      if (!r.value) return pending()
      w = r.value
    }
    let data: string = String(w.bytes_b64 || "")
    if (w.range_evicted || w.start_byte !== at || !data) {
      if (dl.expired) return pending()
      ctx.note("retrieving the saved file result from the runner")
      const requested = await tryCall(() => stub.requestPull(commandId, at, Math.min(WINDOW, total - at)))
      if (!requested.value) return pending()
      const pullClock = makePollClock(100, 500)
      let got: any = null
      do {
        const fetched = await tryCall(() => stub.takePull(requested.value!.req_id))
        if (fetched.value) { got = fetched.value; break }
      } while (await dl.tick(pullClock.next()))
      if (!got) return pending()
      if (got.error || got.start !== at || got.total !== total) return fail("file_result_unavailable", "The saved file result is no longer available or changed", { extra: common, hint: "The result is retained only while its runner storage exists" })
      data = String(got.bytes_b64 || "")
    }
    let chunk: Uint8Array
    try { chunk = bytes(data) } catch { return fail("invalid_file_result", "Invalid result transport encoding", { extra: common }) }
    if (!chunk.length || chunk.length > total - at || Number(w.total_bytes) !== total) return fail("invalid_file_result", "Inconsistent file-result byte range", { extra: common })
    output.set(chunk, at)
    at += chunk.length
  }
  let value: Record<string, any>
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(output))
    if (!value || Array.isArray(value) || typeof value.ok !== "boolean") throw new Error("not an object")
    if (!expectedOp && value.file_result_version !== 1) throw new Error("not a file result")
  } catch { return fail("invalid_file_result", "The job did not return a complete typed file result", { extra: common, hint: "Use exec_read for shell output; never concatenate image fragments yourself" }) }
  const { image, ok: succeeded, error, message, retryable, file_result_version: _version, ...rest } = value
  const info = { ...rest, ...common, op: expectedOp ?? value.op, state: w.state, runtime_ms: Number(w.runtime_ms ?? 0), result_pending: false, elapsed_ms: Date.now() - started }
  if (!succeeded) return fail(String(error || "file_operation_failed"), String(message || "File operation failed"), {
    extra: info, warnings, on_error: retryable === "retry" || retryable === "wait" ? "retry" : "stop",
    hint: retryable === "reread" ? "Read the file again and rebuild the edit from its current contents" : null,
  })
  if (image) {
    if (info.op !== "read_image" || image.type !== "image" || !["image/png", "image/jpeg"].includes(image.mimeType) ||
        typeof image.data !== "string" || !image.data.length || image.data.length > MAX_IMAGE_B64 || image.data.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) {
      return fail("invalid_image_result", "The runner did not return a valid bounded image block", { extra: common })
    }
    return withImages(ok(info, { warnings }), [image as ImageContent])
  }
  return ok(info, { warnings })
}
