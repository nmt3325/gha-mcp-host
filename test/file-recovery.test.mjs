import test, { after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
const root = fs.mkdtempSync(path.join(os.tmpdir(), "gha-file-recovery-"))
process.env.GHA_MCP_ROOT = root
process.env.GHA_MCP_ENV_ID = "linux-00000000"
const { runFileJob } = await import("../lib/fileop.mjs")
const { jobDir } = await import("../lib/config.mjs")
const { listRunning } = await import("../lib/control.mjs")
after(() => fs.rmSync(root, { recursive: true, force: true }))
const sha = b => crypto.createHash("sha256").update(b).digest("hex")
function claimed(id, meta) {
  const dir = jobDir(id); fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "started_at"), String(Date.now() - 10000))
  if (meta) fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta))
}
test("failed delivery replays saved bytes without repeating a mutation", async () => {
  const p = path.join(root, "written.txt")
  const job = { command_id: "0000000000000001", op: "write", path: p, cwd: root, content: "original", write_id: "1".repeat(64) }
  await runFileJob(job, async () => false)
  const before = fs.statSync(p).mtimeMs, delivered = []
  await runFileJob({ ...job, content: "must not overwrite" }, async c => { delivered.push(c); return true })
  assert.equal(fs.readFileSync(p, "utf8"), "original")
  assert.equal(fs.statSync(p).mtimeMs, before)
  const raw = fs.readFileSync(path.join(jobDir(job.command_id), "out.raw"))
  assert.equal(sha(Buffer.concat(delivered.map(c => Buffer.from(c.bytes_b64, "base64")))), sha(raw))
  assert.equal(delivered.at(-1).state, "exited")
  assert.throws(() => fs.statSync(path.join(jobDir(job.command_id), "pid")), { code: "ENOENT" })
})
test("a claimed unfinished file job is never executed again", async () => {
  const id = "0000000000000002", p = path.join(root, "must-not-exist")
  claimed(id)
  let calls = 0
  await runFileJob({ command_id: id, op: "write", path: p, content: "bad" }, async () => { calls++; return true })
  assert.equal(calls, 0); assert.throws(() => fs.statSync(p), { code: "ENOENT" })
})
test("a live file worker does not become spawn_gap after five seconds", () => {
  const id = "0000000000000003"
  claimed(id, { kind: "file", state: "running", file_worker_pid: process.pid, started_at: Date.now() - 10000 })
  const r = listRunning().find(r => r.command_id === id)
  assert.equal(r.state, "running"); assert.equal(r.alive, true); assert.equal(r.spawn_gap, false)
})
test("a dead file worker is lost but never reported as an unspawned command", () => {
  const id = "0000000000000004"
  claimed(id, { kind: "file", state: "running", file_worker_pid: 2147483647, started_at: Date.now() - 10000 })
  const r = listRunning().find(r => r.command_id === id)
  assert.equal(r.state, "lost"); assert.equal(r.spawn_gap, false)
  assert.equal(listRunning().find(r => r.command_id === "0000000000000002").spawn_gap, true)
})
test("multi-chunk redelivery preserves raw offsets and the original result", async () => {
  const id = "0000000000000005", p = path.join(root, "large.txt")
  fs.writeFileSync(p, "a".repeat(131072))
  const job = { command_id: id, op: "read", path: p, max_bytes: 131072 }
  await runFileJob(job, async () => false)
  fs.writeFileSync(p, "changed after the original read")
  const chunks = []
  await runFileJob(job, async c => { chunks.push(c); return true })
  assert.ok(chunks.length > 1)
  let at = 0
  for (const c of chunks) { const b = Buffer.from(c.bytes_b64, "base64"); assert.equal(c.start_byte, at); assert.ok(b.length <= 65536); at += b.length }
  assert.equal(chunks.at(-1).state, "exited")
  const body = Buffer.concat(chunks.map(c => Buffer.from(c.bytes_b64, "base64")))
  assert.equal(sha(body), sha(fs.readFileSync(path.join(jobDir(id), "out.raw"))))
  assert.equal(fs.readFileSync(p, "utf8"), "changed after the original read")
})
