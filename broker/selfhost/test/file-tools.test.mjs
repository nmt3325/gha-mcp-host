import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import crypto from "node:crypto"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { setTimeout as sleep } from "node:timers/promises"
import { startServer } from "../dist/server.mjs"

const repo = fileURLToPath(new URL("../../../", import.meta.url))
const sha = b => crypto.createHash("sha256").update(b).digest("hex")
function crc(b) {
  let c = 0xffffffff
  for (const n of b) { c ^= n; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0) }
  return (c ^ 0xffffffff) >>> 0
}
function largePng() {
  const png = fs.readFileSync(path.join(repo, "test/fixtures/media-1px.png"))
  // Valid private ancillary padding, not image pixels or a decompression bomb.
  const data = crypto.randomBytes(3_300_000), type = Buffer.from("npAd")
  const n = Buffer.alloc(4), sum = Buffer.alloc(4)
  n.writeUInt32BE(data.length); sum.writeUInt32BE(crc(Buffer.concat([type, data])))
  return Buffer.concat([png.subarray(0, -12), n, type, data, sum, png.subarray(-12)])
}

test("file tools traverse real MCP, queue, runner and saved-result recovery", { timeout: 100_000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gha-file-integration-"))
  const envId = `linux-${crypto.randomBytes(4).toString("hex")}`
  const runnerRoot = path.join(dir, "runner")
  const fixtures = path.join(dir, "fixtures"); fs.mkdirSync(fixtures)
  const settings = {
    HOST: "127.0.0.1", PORT: "0", DATA_DIR: path.join(dir, "broker"),
    GITHUB_OWNER: "local-integration-test", GITHUB_REPO: "no-dispatch",
    GITHUB_PAT_DISPATCH: "not-used-by-this-test", MCP_AUTH_TOKEN: crypto.randomBytes(32).toString("hex"),
    BROKER_SECRET: crypto.randomBytes(32).toString("hex"),
  }
  const slowRg = path.join(dir, "slow-rg.mjs")
  fs.copyFileSync(fileURLToPath(new URL("./slow-rg.mjs", import.meta.url)), slowRg)
  fs.chmodSync(slowRg, 0o755)
  let broker, agent, logFd
  t.after(async () => {
    if (agent && agent.exitCode === null) {
      agent.kill("SIGTERM")
      for (let i = 0; i < 20 && agent.exitCode === null && agent.signalCode === null; i++) await sleep(100)
      if (agent.exitCode === null && agent.signalCode === null) {
        try { process.kill(process.platform === "win32" ? agent.pid : -agent.pid, "SIGKILL") } catch {}
      }
    }
    await broker?.close()
    if (logFd !== undefined) fs.closeSync(logFd)
    fs.rmSync(dir, { recursive: true, force: true })
  })
  broker = await startServer(settings)
  settings.PORT = new URL(broker.origin).port
  const stub = broker.env.ENV_DO.get(broker.env.ENV_DO.idFromName(envId))
  await stub.provision({ envId, platform: "linux", ttlMinutes: 10, label: "local integration, not a dispatched workflow", createdBy: null })
  await stub.setDispatch({ runId: "1", runAttempt: "1", runUrl: null })
  logFd = fs.openSync(path.join(dir, "agent.log"), "a")
  agent = spawn(process.execPath, [path.join(repo, "agent.mjs"), "--role=control"], {
    cwd: repo, detached: process.platform !== "win32", stdio: ["ignore", logFd, logFd],
    env: { ...process.env, GHA_MCP_ENV_ID: envId, GHA_MCP_ROOT: runnerRoot,
      GHA_MCP_RG: slowRg, GHA_MCP_TEST_REAL_RG: process.env.GHA_MCP_RG || "rg",
      BROKER_URL: broker.origin, BROKER_SECRET: settings.BROKER_SECRET,
      GITHUB_RUN_ID: "1", GITHUB_RUN_ATTEMPT: "1", GHA_MCP_EXEC_WORKERS: "4" },
  })
  let ready = false
  for (let i = 0; i < 150; i++) {
    if ((await stub.snapshot(false)).state === "ready") { ready = true; break }
    if (agent.exitCode !== null) break
    await sleep(100)
  }
  assert.ok(ready, fs.readFileSync(path.join(dir, "agent.log"), "utf8"))
  let id = 0
  async function rpc(method, params = {}) {
    const requestId = ++id
    const response = await fetch(`${broker.origin}/mcp`, { method: "POST",
      headers: { authorization: `Bearer ${settings.MCP_AUTH_TOKEN}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }), signal: AbortSignal.timeout(48_000),
    })
    const text = await response.text()
    assert.equal(response.status, 200, text.slice(0, 1000))
    const records = response.headers.get("content-type")?.includes("text/event-stream")
      ? text.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => JSON.parse(l.slice(5).trim())) : [JSON.parse(text)]
    const reply = records.find(r => r.id === requestId)
    assert.ok(reply); assert.equal(reply.error, undefined, JSON.stringify(reply.error))
    return reply.result
  }
  const tool = (name, args) => rpc("tools/call", { name, arguments: { env_id: envId, ...args } })
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "file-integration", version: "1" } })
  let imageId, large
  await t.test("new tools are registered and small images are native, not JSON data", async () => {
    const list = await rpc("tools/list")
    for (const name of ["file_read_image", "file_list", "file_glob", "file_grep", "file_read_many", "file_result"]) assert.ok(list.tools.some(t => t.name === name), name)
    const small = path.join(repo, "test/fixtures/media-1px.png")
    const r = await tool("file_read_image", { path: small })
    assert.equal(r.structuredContent.ok, true, JSON.stringify(r.structuredContent))
    assert.equal(r.content.filter(c => c.type === "image").length, 1)
    assert.equal(r.content.find(c => c.type === "image").data, fs.readFileSync(small).toString("base64"))
    assert.equal(r.structuredContent.image, undefined)
    assert.equal(JSON.parse(r.content.find(c => c.type === "text").text).image, undefined)
  })
  await t.test("image larger than the broker window/ring is reassembled on the server", async () => {
    large = largePng(); const p = path.join(fixtures, "large.png"); fs.writeFileSync(p, large)
    let r = await tool("file_read_image", { path: p, deadline_ms: 45000 })
    imageId = r.structuredContent.command_id
    if (r.structuredContent.result_pending) r = await tool("file_result", { command_id: imageId, deadline_ms: 45000 })
    assert.equal(r.structuredContent.ok, true, JSON.stringify(r.structuredContent))
    const image = r.content.find(c => c.type === "image")
    assert.ok(image, "must return native image content")
    assert.equal(sha(Buffer.from(image.data, "base64")), sha(large))
    const job = path.join(runnerRoot, envId, "jobs", imageId)
    for (const f of ["out.raw", "meta.json", "rc"]) assert.ok(fs.statSync(path.join(job, f)).isFile(), f)
    assert.ok(fs.statSync(path.join(job, "out.raw")).size > 4_194_304)
  })
  await t.test("broker restart recovers the original image from the same runner job", async () => {
    await broker.close(); broker = await startServer(settings)
    const r = await tool("file_result", { command_id: imageId, deadline_ms: 45000 })
    assert.equal(r.structuredContent.ok, true, JSON.stringify(r.structuredContent))
    assert.equal(r.structuredContent.command_id, imageId)
    const image = r.content.find(c => c.type === "image"); assert.ok(image)
    assert.equal(sha(Buffer.from(image.data, "base64")), sha(large))
  })
  await t.test("a real slow file worker stays live without a command pid file", async () => {
    const first = (await tool("file_grep", { path: fixtures, pattern: "file-tools-slow-probe", deadline_ms: 1000 })).structuredContent
    assert.equal(first.result_pending, true)
    await sleep(5500)
    const job = path.join(runnerRoot, envId, "jobs", first.command_id)
    const meta = JSON.parse(fs.readFileSync(path.join(job, "meta.json"), "utf8"))
    assert.equal(meta.kind, "file"); assert.equal(meta.state, "running")
    assert.ok(Number.isSafeInteger(meta.file_worker_pid))
    assert.equal(fs.existsSync(path.join(job, "pid")), false)
    const state = await broker.env.ENV_DO.get(broker.env.ENV_DO.idFromName(envId)).window(first.command_id, 0, 1024)
    assert.notEqual(state.state, "lost")
    const result = (await tool("file_result", { command_id: first.command_id, deadline_ms: 20000 })).structuredContent
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.items.length, 0)
  })
  await t.test("pending writes are retrieved, never submitted again", async () => {
    await Promise.all(Array.from({ length: 4 }, (_, i) => tool("exec", { command: `sleep 6; printf delay-${i}`, deadline_ms: 1000, idle_return_ms: 10000 })))
    const p = path.join(fixtures, "pending.txt")
    const pending = (await tool("file_write", { path: p, content: "hello あ🙂", deadline_ms: 1000 })).structuredContent
    assert.equal(pending.result_pending, true, JSON.stringify(pending))
    const result = await tool("file_result", { command_id: pending.command_id, deadline_ms: 20000 })
    assert.equal(result.structuredContent.ok, true, JSON.stringify(result.structuredContent))
    assert.equal(fs.readFileSync(p, "utf8"), "hello あ🙂")
    const mtime = fs.statSync(p).mtimeMs
    await tool("file_result", { command_id: pending.command_id })
    assert.equal(fs.statSync(p).mtimeMs, mtime)
  })
  await t.test("text, preview, discovery and typed failures survive MCP serialization", async () => {
    const p = path.join(fixtures, "editable.txt")
    assert.equal((await tool("file_write", { path: p, content: "old $& あ\n" })).structuredContent.ok, true)
    const current = (await tool("file_read", { path: p })).structuredContent
    const edit = (await tool("file_edit", { path: p, old_str: "old", new_str: "new", base_sha: current.base_sha, dry_run: true })).structuredContent
    assert.equal(edit.dry_run, true); assert.match(edit.diff, /-old/)
    assert.equal(fs.readFileSync(p, "utf8"), "old $& あ\n")
    const many = (await tool("file_read_many", { paths: [p, path.join(fixtures, "absent")] })).structuredContent
    assert.equal(many.failed_count, 1)
    assert.ok((await tool("file_list", { path: fixtures })).structuredContent.items.length >= 2)
    const glob = (await tool("file_glob", { path: fixtures, pattern: "*.txt" })).structuredContent
    assert.equal(glob.ok, true, JSON.stringify(glob)); assert.equal(glob.items.length, 2)
    const grep = (await tool("file_grep", { path: fixtures, pattern: "$&" })).structuredContent
    assert.equal(grep.ok, true, JSON.stringify(grep)); assert.equal(grep.items.length, 1)
    const bad = await tool("file_read_image", { path: p })
    assert.equal(bad.isError, true); assert.equal(bad.structuredContent.error.code, "unsupported_image")
    const shell = (await tool("exec", { command: "printf ordinary-shell-output", deadline_ms: 5000 })).structuredContent
    const wrong = await tool("file_result", { command_id: shell.command_id })
    assert.equal(wrong.structuredContent.error.code, "invalid_file_result")
    const both = await tool("file_write", { path: p, content: "a", content_b64: "Yg==" })
    assert.equal(both.structuredContent.error.code, "bad_input")
  })
})
