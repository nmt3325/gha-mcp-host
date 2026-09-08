/* Bounded directory and ripgrep adapters; never assemble a shell command. */
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"

const MAX_REPLY_BYTES = 96 * 1024
const fail = (error, message, extra = {}) => ({ ok: false, error, phase: "precheck", retryable: "fix_args", message, ...extra })
const integer = (n, d, max) => Number.isSafeInteger(n) && n > 0 ? Math.min(n, max) : d

function capped(items, maxResults) {
  const out = []; let bytes = 2
  for (const item of items) {
    const size = Buffer.byteLength(JSON.stringify(item)) + 1
    if (out.length >= maxResults || bytes + size > MAX_REPLY_BYTES) return { items: out, truncated: true }
    out.push(item); bytes += size
  }
  return { items: out, truncated: false }
}

export function listDirectory(a) {
  try {
    const root = a.path
    if (!fs.statSync(root).isDirectory()) return fail("not_directory", "path must be a directory")
    const entries = []
    // Bound enumeration itself instead of collecting an unbounded directory.
    const dir = fs.opendirSync(root)
    let entry, scanned = 0, scanCapped = false
    try {
      while ((entry = dir.readSync())) {
        if (++scanned > 10000) { scanCapped = true; break }
        if (!a.hidden && entry.name.startsWith(".")) continue
        entries.push({ name: entry.name, path: path.join(root, entry.name), type: entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other" })
      }
    } finally { dir.closeSync() }
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    const result = capped(entries, integer(a.max_results, 200, 1000))
    return { ok: true, path_resolved: root, ...result, scanned, scan_capped: scanCapped, truncated: scanCapped || result.truncated, order: scanCapped ? "sorted_scanned_subset" : "name", follows_symlinks: false }
  } catch (e) { return fail("list_failed", "Could not list directory", { errno: e.code ?? null }) }
}

function runRg(args, cwd, deadline = Date.now() + 20_000) {
  const exe = process.env.GHA_MCP_RG || "rg"
  const remaining = deadline - Date.now()
  if (remaining <= 0) return { failure: fail("search_limit", "Search exceeded its shared time budget; narrow the path") }
  const r = spawnSync(exe, args, { cwd, timeout: Math.min(20_000, remaining), maxBuffer: 2 * 1024 * 1024, windowsHide: true })
  if (r.error) {
    if (r.error.code === "ENOENT") return { failure: fail("ripgrep_unavailable", "Install ripgrep or set GHA_MCP_RG on the runner agent; no downloads occur during a tool call") }
    return { failure: fail("search_limit", "Search exceeded its time or intermediate-output budget; narrow path or pattern", { errno: r.error.code ?? null }) }
  }
  if (r.status !== 0 && r.status !== 1) return { failure: fail("search_failed", "ripgrep refused this query", { exit_code: r.status, detail: (r.stderr || "").toString().slice(0, 1000) }) }
  try { return { text: new TextDecoder("utf-8", { fatal: true }).decode(r.stdout || Buffer.alloc(0)) } }
  catch { return { failure: fail("non_utf8_search_output", "File names must be valid UTF-8; narrow the search to UTF-8 paths") } }
}

function flags(a) {
  return ["--no-config", "--no-follow", ...(a.hidden ? ["--hidden"] : []), ...(a.include_ignored ? ["--no-ignore"] : []), "--glob", "!.git/**", "--glob", "!**/.git/**"]
}

export function globFiles(a) {
  if (!a.pattern || typeof a.pattern !== "string") return fail("bad_input", "pattern must be nonempty")
  // Two bounded traversals share one deadline. Positive globs must not override ignore rules.
  const deadline = Date.now() + 20_000
  const r = runRg([...flags(a), "--files", "--null", "."], a.path, deadline)
  if (r.failure) return r.failure
  const candidates = new Set(r.text.split("\0").filter(Boolean).map(p => path.resolve(a.path, p)))
  if (!candidates.size) return { ok: true, path_resolved: a.path, items: [], truncated: false }
  const selected = runRg([...flags(a), "--files", "--null", "--glob", a.pattern, "--glob", "!.git/**", "--glob", "!**/.git/**", "."], a.path, deadline)
  if (selected.failure) return selected.failure
  const matched = selected.text.split("\0").filter(Boolean).map(p => path.resolve(a.path, p)).filter(p => candidates.has(p)).sort()
  return { ok: true, path_resolved: a.path, pattern: a.pattern, ...capped(matched, integer(a.max_results, 200, 1000)), include_ignored: !!a.include_ignored, hidden: !!a.hidden, follows_symlinks: false }
}

export function grepFiles(a) {
  if (!a.pattern || typeof a.pattern !== "string") return fail("bad_input", "pattern must be nonempty")
  const args = [...flags(a), "--json", "--line-number", "--max-columns", "4000", ...(a.fixed_strings === false ? [] : ["--fixed-strings"]), ...(a.case_sensitive === false ? ["--ignore-case"] : []), "--", a.pattern, "."]
  const r = runRg(args, a.path)
  if (r.failure) return r.failure
  const items = []
  let skippedNonUtf8 = 0
  for (const line of r.text.split("\n")) {
    if (!line) continue
    let event
    try { event = JSON.parse(line) } catch { return fail("search_failed", "ripgrep returned incomplete JSON; narrow the query") }
    if (event.type !== "match") continue
    const p = event.data.path.text, text = event.data.lines.text
    if (typeof p !== "string" || typeof text !== "string") { skippedNonUtf8++; continue }
    items.push({ path: path.resolve(a.path, p), line: event.data.line_number, text: text.replace(/\r?\n$/, ""), matches: event.data.submatches.map(m => ({ start_byte: m.start, end_byte: m.end })) })
  }
  const result = capped(items, integer(a.max_results, 100, 1000))
  return { ok: true, path_resolved: a.path, pattern: a.pattern, ...result, skipped_non_utf8: skippedNonUtf8, fixed_strings: a.fixed_strings !== false, include_ignored: !!a.include_ignored, hidden: !!a.hidden, follows_symlinks: false }
}
