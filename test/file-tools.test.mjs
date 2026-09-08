import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { handleFileOp } from "../lib/fileop.mjs"
import { IMAGE_MAX_BYTES } from "../lib/file-media.mjs"

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gha-new-files-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}
function put(root, name, data) { const p = path.join(root, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); return p }
const fixturePath = name => fileURLToPath(new URL(`fixtures/${name}`, import.meta.url))

test("PNG and JPEG become image blocks with byte-identical data, not text", () => {
  for (const [name, mime] of [["media-1px.png", "image/png"], ["media-1px.jpg", "image/jpeg"]]) {
    const p = fixturePath(name)
    const r = handleFileOp({ op: "read_image", path: p })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.image.type, "image")
    assert.equal(r.image.mimeType, mime)
    assert.equal(r.width, 1); assert.equal(r.height, 1)
    assert.deepEqual(Buffer.from(r.image.data, "base64"), fs.readFileSync(p))
    assert.equal(r.transformed, false)
  }
})

test("image reading sniffs bytes, not file extensions", t => {
  const d = fixture(t)
  const p = put(d, "not-an-image.png", "ordinary text")
  assert.equal(handleFileOp({ op: "read_image", path: p }).error, "unsupported_image")
  const q = put(d, "image.data", fs.readFileSync(fixturePath("media-1px.png")))
  assert.equal(handleFileOp({ op: "read_image", path: q }).mimeType, "image/png")
})

test("image limits and incomplete or unsupported containers fail without partial media", t => {
  const d = fixture(t)
  const png = fs.readFileSync(fixturePath("media-1px.png"))
  for (const [name, data, error] of [
    ["too-large", Buffer.alloc(IMAGE_MAX_BYTES + 1), "image_too_large"],
    ["truncated.png", png.subarray(0, png.length - 12), "unsupported_image"],
    ["vector.svg", "<svg xmlns='http://www.w3.org/2000/svg'/>", "unsupported_image"],
    ["animated.gif", "GIF89a\u0000\u0000", "unsupported_image"],
  ]) {
    const r = handleFileOp({ op: "read_image", path: put(d, name, data) })
    assert.equal(r.error, error); assert.equal(r.image, undefined)
  }
  const excessive = Buffer.from(png); excessive.writeUInt32BE(9000, 16)
  assert.equal(handleFileOp({ op: "read_image", path: put(d, "wide.png", excessive) }).error, "image_dimensions_exceeded")
  assert.equal(handleFileOp({ op: "read_image", path: d }).error, "not_regular_file")
})

test("UTF-8 windows make progress without dropping multibyte characters", t => {
  const d = fixture(t), text = "Aあ🙂漢B".repeat(30)
  const p = put(d, "日本語.txt", text)
  for (const budget of [1, 2, 3, 5, 7, 32, 1024]) {
    let at = 0, joined = ""
    for (let n = 0; n < 1000; n++) {
      const r = handleFileOp({ op: "read", path: p, from_byte: at, max_bytes: budget })
      assert.equal(r.ok, true, JSON.stringify(r))
      assert.ok(r.bytes_returned <= budget + 3)
      joined += r.text
      if (r.next_byte === undefined) break
      assert.ok(r.next_byte > at); at = r.next_byte
    }
    assert.equal(joined, text)
  }
})

test("invalid UTF-8 is still rejected and a mid-codepoint offset is not silently skipped", t => {
  const d = fixture(t)
  assert.equal(handleFileOp({ op: "read", path: put(d, "bad", Buffer.from([65, 128, 66])) }).error, "not_utf8")
  assert.equal(handleFileOp({ op: "read", path: put(d, "valid", "あいう"), from_byte: 1 }).error, "not_utf8")
})

test("explicit cwd resolves independent same-name files", t => {
  const d = fixture(t)
  put(d, "a/item", "first"); put(d, "b/item", "second")
  assert.equal(handleFileOp({ op: "read", path: "item", cwd: path.join(d, "a") }).text, "first")
  assert.equal(handleFileOp({ op: "read", path: "item", cwd: path.join(d, "b") }).text, "second")
  assert.equal(handleFileOp({ op: "read", path: "item", cwd: "relative" }).error, "bad_input")
})

test("plain UTF-8 writes preserve literal data and require exactly one encoding", t => {
  const d = fixture(t), p = path.join(d, "item")
  const text = "\uFEFFあ🙂\r\n$& $1 \\ code\r\n"
  assert.equal(handleFileOp({ op: "write", path: p, content: text }).ok, true)
  assert.equal(fs.readFileSync(p, "utf8"), text)
  assert.equal(handleFileOp({ op: "write", path: p, content: "a", content_b64: "Yg==" }).error, "bad_input")
  assert.equal(handleFileOp({ op: "write", path: p, content: "\uD800" }).error, "invalid_unicode")
  assert.equal(fs.readFileSync(p, "utf8"), text)
})

test("dry-run validates an exact edit and emits a diff without changing bytes", t => {
  const d = fixture(t), p = put(d, "code", "start\r\nold\r\nend\r\n")
  const before = fs.readFileSync(p)
  const read = handleFileOp({ op: "read", path: p })
  const job = { op: "edit", path: p, old_str: "old", new_str: "new", base_sha: read.base_sha, write_id: "preview-replay" }
  const preview = handleFileOp({ ...job, dry_run: true })
  assert.equal(preview.dry_run, true); assert.match(preview.diff, /-old\n\+new/)
  assert.deepEqual(fs.readFileSync(p), before)
  assert.equal(preview.sha_verified, undefined)
  assert.equal(handleFileOp({ ...job, dry_run: false }).ok, true)
  assert.equal(fs.readFileSync(p, "utf8"), "start\r\nnew\r\nend\r\n")
})

test("read-many keeps independent errors and a global source-byte budget", t => {
  const d = fixture(t), good = put(d, "good", "hello"), binary = put(d, "binary", Buffer.from([0, 1]))
  const r = handleFileOp({ op: "read_many", paths: [good, binary, path.join(d, "missing")] })
  assert.equal(r.ok, true); assert.equal(r.failed_count, 2); assert.equal(r.results[0].text, "hello")
  const big = put(d, "big", "x".repeat(2048))
  const b = handleFileOp({ op: "read_many", paths: [big, good], max_bytes_total: 1024 })
  assert.equal(b.results[0].next_byte, 1024); assert.equal(b.results[1].error, "read_budget_exhausted")
})

test("directory results are sorted, bounded, and hidden is opt-in", t => {
  const d = fixture(t)
  for (const n of ["z", "a", ".hidden"]) put(d, n, "")
  const r = handleFileOp({ op: "list", path: d, max_results: 1 })
  assert.deepEqual(r.items.map(v => v.name), ["a"]); assert.equal(r.truncated, true)
  assert.deepEqual(handleFileOp({ op: "list", path: d, hidden: true }).items.map(v => v.name), [".hidden", "a", "z"])
})

test("ripgrep absence is an actionable error, never an automatic download", t => {
  const d = fixture(t), old = process.env.GHA_MCP_RG
  process.env.GHA_MCP_RG = path.join(d, "no-such-rg")
  try { assert.equal(handleFileOp({ op: "grep", path: d, pattern: "x" }).error, "ripgrep_unavailable") }
  finally { if (old === undefined) delete process.env.GHA_MCP_RG; else process.env.GHA_MCP_RG = old }
})

test("real ripgrep glob/grep respect ignore rules, literals and output limits", t => {
  const d = fixture(t)
  const version = spawnSync(process.env.GHA_MCP_RG || "rg", ["--version"])
  assert.equal(version.status, 0, "ripgrep must be provisioned for the integration tests")
  assert.equal(spawnSync("git", ["init", "--quiet", d]).status, 0)
  put(d, ".gitignore", "ignored.js\n")
  put(d, "src/valid.js", "token.+ literal\ntoken42 regex\n")
  put(d, "ignored.js", "token.+ ignored\n")
  put(d, ".hidden.js", "token.+ hidden\n")
  put(d, "note.txt", "token.+ text\n")
  const glob = handleFileOp({ op: "glob", path: d, pattern: "**/*.js" })
  assert.equal(glob.ok, true, JSON.stringify(glob)); assert.deepEqual(glob.items.map(p => path.basename(p)), ["valid.js"])
  const all = handleFileOp({ op: "glob", path: d, pattern: "**/*.js", include_ignored: true, hidden: true })
  assert.deepEqual(all.items.map(p => path.basename(p)).sort(), [".hidden.js", "ignored.js", "valid.js"])
  const literal = handleFileOp({ op: "grep", path: d, pattern: "token.+" })
  assert.equal(literal.ok, true, JSON.stringify(literal)); assert.equal(literal.items.length, 2)
  const regex = handleFileOp({ op: "grep", path: d, pattern: "token.+", fixed_strings: false })
  assert.equal(regex.items.length, 3)
  const small = handleFileOp({ op: "grep", path: d, pattern: "token", max_results: 1 })
  assert.equal(small.items.length, 1); assert.equal(small.truncated, true)
  const odd = put(d, "$(touch SHOULD_NOT_EXIST).txt", "'; touch SHOULD_NOT_EXIST; #")
  const safe = handleFileOp({ op: "grep", path: d, pattern: "'; touch SHOULD_NOT_EXIST; #" })
  assert.equal(safe.items[0].path, odd)
  assert.throws(() => fs.statSync(path.join(d, "SHOULD_NOT_EXIST")), { code: "ENOENT" })
})
