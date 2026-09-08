import { z } from "zod"
import type { ToolDef } from "./mcp"
import type { Bindings } from "./tools-shared"
import { collectFileResult } from "./file-result"
import { submitFile } from "./tools-file"

const Env = z.string().regex(/^(linux|mac|win)-[0-9a-hjkmnp-tv-z]{8}$/)
const Path = z.string().min(1).max(4096)
const common = { env_id: Env, cwd: Path.optional(), deadline_ms: z.number().optional() }
const root = { ...common, path: Path }
const search = { ...root, pattern: z.string().min(1).max(4096), hidden: z.boolean().optional(), include_ignored: z.boolean().optional(), max_results: z.number().int().min(1).max(1000).optional() }

export function buildExtraFileTools(env: Bindings): ToolDef[] {
  const definition = (name: string, title: string, description: string, inputSchema: any, op: string): ToolDef => ({
    name, title, description, inputSchema, readOnly: true,
    async handler(args, ctx) {
      const { env_id, deadline_ms, ...rest } = args
      return submitFile(env, env_id, op, rest, deadline_ms, ctx)
    },
  })
  return [
    definition("file_read_image", "Read a local image", "Read a static PNG/JPEG on the RUNNER as native MCP image content for vision. This is not OCR. Maximum 4 MiB, 8192px per dimension, 32 megapixels. Original bytes are unchanged; no resize is performed. Header/container checks do not replace a full image decoder. Use an absolute path or explicit cwd. If result_pending is true, call file_result with that command_id; do not resubmit or use exec_read to assemble Base64.", z.strictObject(root), "read_image"),
    definition("file_list", "List directory entries", "List one directory, sorted by name; symlink entries are listed but never followed. Hidden entries are off by default. Bounded to 10000 scanned entries and 96 KiB of result entries. truncated and scan_capped distinguish incomplete results; narrow the path rather than assuming a full tree.", z.strictObject({ ...root, hidden: z.boolean().optional(), max_results: z.number().int().min(1).max(1000).optional() }), "list"),
    definition("file_glob", "Find files by glob", "Find files recursively by a ripgrep glob. Respects ignore files unless include_ignored=true; hidden files require hidden=true. Does not follow symlinks or scan .git. Requires rg installed or GHA_MCP_RG on the runner. Results are bounded; search_limit means narrow the query. No shell quoting or shell expansion.", z.strictObject(search), "glob"),
    definition("file_grep", "Search file contents", "Search recursively with ripgrep and return structured file paths, 1-based line numbers and byte match offsets. Literal strings by default; fixed_strings=false selects Rust regular expressions (not PCRE). Ignore files apply unless include_ignored=true. Hidden files require hidden=true. Does not follow symlinks or scan .git. Bounded time, intermediate output and returned entries; narrow the query if a limit is reported.", z.strictObject({ ...search, fixed_strings: z.boolean().optional(), case_sensitive: z.boolean().optional() }), "grep"),
    definition("file_read_many", "Read related text files", "Read up to 20 UTF-8 files in one job. Each file has an independent result/error and base_sha. max_bytes_total bounds source bytes across files (up to three extra bytes per file to finish a UTF-8 character). This is not a filesystem snapshot or a batch-write transaction. Images must use file_read_image.", z.strictObject({ ...common, paths: z.array(Path).min(1).max(20), max_bytes_total: z.number().int().min(1024).max(131072).optional(), limit: z.number().int().min(1).max(100000).optional() }), "read_many"),
    {
      name: "file_result", title: "Retrieve a file or image result", readOnly: true,
      description: "Retrieve the SAME file job after a pending response, disconnect or timeout. Reassembles bounded saved bytes server-side and returns native images when appropriate. Never repeats a write. Results are available while runner storage exists. For arbitrary shell output use exec_read instead.",
      inputSchema: z.strictObject({ env_id: Env, command_id: z.string().regex(/^[a-f0-9]{16}$/), deadline_ms: z.number().optional() }),
      handler: (a, ctx) => collectFileResult(env, a.env_id, a.command_id, a.deadline_ms, ctx),
    },
  ]
}
