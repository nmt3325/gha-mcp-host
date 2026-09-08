# File and media tools

These tools extend the existing GHA queue, raw-byte result transport and exact-edit engine. They do not require an editor application, language model runtime or fuzzy patch parser on the runner.

## New tools

| Tool | Contract |
| --- | --- |
| `file_read_image` | Original static PNG/JPEG bytes as a native MCP image block; not OCR |
| `file_list` | One directory, sorted names, explicit truncation; symlinks listed but not traversed |
| `file_glob` | Recursive ripgrep globs; ignore/hidden behavior is explicit |
| `file_grep` | Structured path, line and byte-match positions; literal strings by default |
| `file_read_many` | Up to 20 independent text reads, per-file hashes/errors, shared byte budget |
| `file_result` | Retrieve the original file job, without repeating its operation |

Existing `file_read`, `file_write` and `file_edit` accept explicit `cwd`. The broker freezes the working directory before submission. Prefer absolute paths or explicit `cwd` when several clients share a runner.

`file_write` accepts either UTF-8 `content` or `content_b64`, never both. The plain-text input limit is 512 KiB; the entire serialized job is capped at 1,000,000 bytes. `file_edit` supports `dry_run: true`: matching and `base_sha` are validated, but no file is written. The returned diff is a bounded preview, not an applyable patch.

## Bounds and interpretation

- Images: 4 MiB, 8192 pixels per dimension, 32 million pixels. Only PNG and JPEG; animated PNG is refused. Header/container checks are not full pixel decoding or CRC validation. No automatic resize, crop, EXIF orientation change, PDF conversion or OCR.
- Text windows extend by at most three bytes to complete a UTF-8 character. A caller-supplied offset inside a character is still refused. BOM/CRLF and literal replacement strings are preserved.
- Multi-read: at most 128 KiB of requested source bytes in total, plus UTF-8 completion bytes. Files are not read as a transactional snapshot.
- Listing: at most 10,000 scanned entries. Discovery results: at most 96 KiB of entries and 1,000 requested results. Check `truncated` and `scan_capped`; an incomplete result is not a complete tree.
- Searches require an installed `rg` or `GHA_MCP_RG` in the **agent's** environment. No automatic download occurs during tool calls. The shared search time budget is 20 seconds; intermediate output is capped at 2 MiB. Hidden files require opt-in; `.git` and symlink traversal are excluded. Regex mode uses Rust regexes, not PCRE.

## Recovery

A `result_pending` response means the result has not been fully collected; the underlying job may already be finished. Keep its `command_id` and call `file_result`. Do not submit the mutation again just because the request deadline elapsed.

The runner retains one bounded `out.raw` plus terminal metadata. Results are assembled server-side in raw-byte order, including runner pull requests for evicted ranges. Do not concatenate Base64 fragments in model context. Queue redelivery never reruns a claimed file handler: only a complete saved result with a matching hash is resent. Active file jobs publish their worker liveness separately from shell command PIDs, so `exec_kill` cannot accidentally target an exec worker by a file-job ID.

Recovery lasts only while the runner storage exists. This does not recreate a destroyed runner or guarantee recovery from every disk/crash failure. A persistence error can occur after a mutation committed; check `mutation_may_have_committed`, inspect the file, and do not retry blindly. `file_result` rejects ordinary shell output; use `exec_read` for shell jobs. Deploy the updated broker and runner together; legacy runners do not provide the new tools or saved-result contract.

## Concurrency limits

The queue is **not** a per-environment mutex. Different worker processes, other commands and outside writers can touch the same path concurrently. Existing atomic replacement and `base_sha` checks are not a cross-process transaction. There is no shared per-path lock, persistent cross-worker write replay cache, or multi-file atomic patch in this change. Same-command result replay is a separate guarantee from concurrent-writer exclusion.

## MCP media is not proof of model vision

Image data appears once, in native MCP `content[type=image]`. It is excluded from the text block and `structuredContent`. A client must still promote that image block into multimodal model input; displaying JSON or Base64 is not sufficient.

In a real Notion AI GPT-5.5 trial on 2026-09-08, native image content reached the MCP boundary, but the model reported seeing only metadata/Base64 and did **not** read the image. This change therefore does not claim working vision for every Notion AI/client path. In a separate Notion AI trial, listing, globbing, grep, Japanese multi-read, dry-run preview and an unchanged-file re-read all succeeded. The experimental endpoint exposed only synthetic samples and forced preview-only edits; it was not a production cutover.

## Verification

```sh
# Node 22+; rg must be available, or set GHA_MCP_RG
node --test test/*.test.mjs
npm install --prefix broker --package-lock=false
npm run typecheck --prefix broker
npm test --prefix broker
# Self-host integration uses Node 24 and an isolated local broker/runner.
npm ci --prefix broker/selfhost
npm run build --prefix broker/selfhost
npm test --prefix broker/selfhost
```

Integration tests exercise actual HTTP MCP, queueing and runner processes: native images, a >4 MiB encoded result, broker restart/pull recovery, a file search lasting longer than the spawn-gap threshold, delayed write retrieval without repetition, previews and typed errors. They manually provision an isolated test namespace; they do not dispatch GitHub workflows or use production credentials. Local transport fault tests cover saved-result redelivery and unfinished claims. CI provisions ripgrep rather than silently skipping search tests.
