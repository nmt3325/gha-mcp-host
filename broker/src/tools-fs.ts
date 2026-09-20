/*
 * The file lane: read_file, write_file, list_directory, get_image, get_file.
 *
 * read_file and write_file are queue jobs, not a new transport. A file job is
 * enqueued with type:"file", claimed by the same worker as a command, and its
 * result arrives as that job's one and only output chunk -- so window(), the
 * ring buffer, kill and the redelivery rules all work unchanged and the DO wire
 * contract does not move. Two consequences worth knowing:
 *
 *  - The queue is shared with commands. A write waits behind a running command
 *    and vice versa. That is the price of per-environment serialisation, and
 *    serialisation is what stops our own tools racing each other on one path.
 *  - If the deadline passes before the runner answers, the job is still a
 *    normal queue entry: poll_job(job_id) resumes it. Nothing is lost, which is
 *    why running out of time here is not reported as a failure.
 *
 * list_directory, get_image and get_file take the other route and run a command, because
 * a file job's result is pushed as a single chunk with no re-readable raw file
 * behind it: that caps it at one window, which an image immediately exceeds.
 *
 * write_file is where this differs most from the tool it replaces. local-mcp
 * answers a write with `Edited <path> (+3 -1)` and a diff, and that summary is
 * most of the value: it is how the caller learns the write did something other
 * than what it intended. So write_file reads the file first, then writes it
 * conditionally on what it just read, and computes the diff in the broker.
 */

import { posixQuote, pwshQuote } from "./argv"
import { b64decode, b64encode } from "./bytes"
import type { BrokerConfig, Platform } from "./config"
import { unifiedDiff } from "./diff"
import { MCP_CONTENT_KEY, type ToolDef } from "./mcp"
import { Deadline, SOFT_CAP_MS, clamp, fail, makePollClock, numArg, ok } from "./result"
import {
	GetFileInput,
	GetImageInput,
	ListDirectoryInput,
	ReadFileInput,
	WriteFileInput,
	type GetFileArgs,
	type GetImageArgs,
	type ListDirectoryArgs,
	type ReadFileArgs,
	type WriteFileArgs,
} from "./schemas"
import { type Bindings, envStub, isTerminal, platformOf, sha256Hex, tryCall } from "./tools-shared"
import { ensureReady, runCapture } from "./tools-run"

/** Window we ask the DO for. The runner keeps its result JSON under this. */
const RESULT_WINDOW_BYTES = 262_144
/** Ceiling on a single read, so the JSON envelope stays inside the window. */
const READ_MAX_BYTES = 131_072
/** Ceiling on base64 content, so one queue entry stays under the DO's 2MB. */
const WRITE_MAX_B64 = 700_000
/** sha256 of nothing. As a base_sha it means "this file must not exist yet". */
const SHA256_EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

const RESULT_POLL_MIN_MS = 200
const RESULT_POLL_MAX_MS = 2_000

/**
 * Cap on an image, in base64 characters: ~1.5 MiB of binary.
 *
 * The whole thing is buffered in the Worker and then sent inline in one tool
 * result, so this is not about disk -- it is about the two places that fall over
 * first: Worker memory and whatever the client will accept in a single message.
 */
const MAX_IMAGE_B64_CHARS = 2_100_000

/**
 * Generic files ride in one MCP embedded-resource result. Five MiB matches a
 * Free workspace's per-file ceiling and keeps the base64 response below 7 MiB.
 */
const MAX_FILE_BYTES = 5 * 1024 * 1024
const MAX_FILE_B64_CHARS = Math.ceil(MAX_FILE_BYTES / 3) * 4

/** The runner's 5 recovery verbs, mapped onto the broker's on_error verb. */
const ON_ERROR_FOR: Record<string, "retry" | "stop"> = {
	fix_args: "stop",
	reread: "stop",
	retry: "retry",
	wait: "retry",
	no: "stop",
}

function decodeJsonChunk(b64: string): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(new TextDecoder().decode(b64decode(b64)))
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null
	} catch {
		return null
	}
}

type FileOutcome =
	| { ok: true; jobId: string; data: Record<string, unknown>; warnings: string[] }
	| { ok: false; payload: Record<string, unknown>; code: string }

/**
 * Enqueue one file job and wait for its single result chunk.
 *
 * Returns the runner's own payload rather than a finished tool result, so
 * write_file can read a file and then write it inside one tool call.
 */
async function fileJob(
	env: Bindings,
	envId: string,
	op: "read" | "write",
	jobArgs: Record<string, unknown>,
	deadlineMsRaw: unknown,
	ctx: { signal: AbortSignal; note: (m: string) => void },
): Promise<FileOutcome> {
	const platform = platformOf(envId)
	const stub = envStub(env, envId)

	const ready = await ensureReady(stub, envId)
	if (!ready.ok) return { ok: false, payload: ready.payload, code: "env" }
	const snap = ready.snap

	const warnings: string[] = [...((snap.warnings as string[]) || [])]
	const deadlineMs = clamp(numArg(deadlineMsRaw, 20000), 1000, 45000)
	const jobId = crypto.randomUUID().replace(/-/g, "").slice(0, 16)

	// write_id is derived from the arguments on the SERVER, not supplied by the
	// caller: a model that retries a write does not reliably resend the same id,
	// and it is exactly that retry we are trying to make idempotent. Identical
	// arguments therefore replay the recorded result instead of writing twice.
	const writeId = await sha256Hex(JSON.stringify([envId, op, jobArgs]))
	const mutating = op !== "read"

	const payload = { command_id: jobId, type: "file", op, write_id: writeId, ...jobArgs }

	const enq = await stub.enqueue({
		command_id: jobId,
		idem_hash: mutating ? `key:file:${writeId}` : `nodedupe:${jobId}`,
		payload,
		label: op === "read" ? "read_file" : "write_file",
		cwd: null,
		shell: null,
		maxQueue: 8,
		idemWindowMs: deadlineMs + 60_000,
	})
	if (!enq.ok) {
		return {
			ok: false,
			code: "runner_busy_queue_full",
			payload: fail(
				"runner_busy_queue_full",
				`the runner already has ${enq.queue_depth} jobs queued (max ${enq.max_queue})`,
				{
					retry_after_ms: 2000,
					hint: "file jobs share the queue with commands; wait for one to finish",
					next_action: "poll_job on an earlier job_id",
				},
			),
		}
	}
	if (enq.deduped) {
		warnings.push("an identical file job was already submitted; returning that one instead of applying it twice")
	}

	const effectiveId: string = enq.command_id
	const dl = new Deadline(Math.min(deadlineMs, SOFT_CAP_MS), ctx.signal)
	const clock = makePollClock(RESULT_POLL_MIN_MS, RESULT_POLL_MAX_MS)
	const started = Date.now()
	let w: any = null
	let pollErrorCode: string | null = null

	for (;;) {
		const r = await tryCall(() => stub.window(effectiveId, 0, RESULT_WINDOW_BYTES))
		if (r.value) {
			w = r.value
			pollErrorCode = null
		} else {
			pollErrorCode = r.pollError?.code ?? null
		}
		if (w && isTerminal(w.state)) break
		ctx.note(w?.state === "queued" ? `${op} queued behind another job` : `${op} running`)
		if (!(await dl.tick(clock.next()))) break
	}

	const common = { job_id: effectiveId, env_id: envId, platform, op, elapsed_ms: Date.now() - started }

	if (!w || !isTerminal(w.state)) {
		// Not a failure: the job is a normal queue entry and its result is readable
		// with poll_job. Saying "failed" here would invite a duplicate write.
		return {
			ok: false,
			code: "still_running",
			payload: ok(
				{
					...common,
					status: "running",
					state: w?.state ?? "queued",
					queue_depth: Number(enq.queue_depth || 0),
					poll_error: pollErrorCode,
				},
				{
					warnings: [...warnings, "the runner has not answered yet; the job is queued or in flight and has NOT been abandoned"],
					hint: "do not resubmit: resubmitting the same write is what duplicates content",
					next_action: `poll_job(env_id: "${envId}", job_id: "${effectiveId}", from_byte: 0, until: "exit")`,
				},
			),
		}
	}

	if (w.state === "lost") {
		return {
			ok: false,
			code: "lost",
			payload: fail("lost", "the runner died before reporting the result of this file job", {
				extra: { ...common, state: w.state, agent_error: w.agent_error ?? null },
				warnings,
				hint: mutating ? "whether the write committed is unknown; read the file back before retrying" : null,
				next_action: `read_file(env_id: "${envId}", path: ...)`,
			}),
		}
	}

	const json = decodeJsonChunk(String(w.bytes_b64 || ""))
	if (!json) {
		return {
			ok: false,
			code: "broker_internal",
			payload: fail("broker_internal", "the runner's file result did not arrive as parseable JSON", {
				on_error: "retry",
				retry_after_ms: 1000,
				extra: { ...common, state: w.state, truncated: Boolean(w.truncated) },
				warnings,
				hint: w.truncated ? "the result exceeded the window; lower max_bytes" : null,
				next_action: `poll_job(env_id: "${envId}", job_id: "${effectiveId}", from_byte: 0)`,
			}),
		}
	}

	if (json.ok === true) {
		const { ok: _ok, ...rest } = json
		return { ok: true, jobId: effectiveId, data: { ...common, ...rest, runtime_ms: Number(w.runtime_ms ?? 0) }, warnings }
	}

	const { ok: _bad, error, message, retryable, ...rest } = json
	const verb = ON_ERROR_FOR[String(retryable)] ?? "stop"
	return {
		ok: false,
		code: String(error || "io_error"),
		payload: fail(String(error || "io_error"), String(message || "the file operation failed"), {
			on_error: verb,
			retry_after_ms: verb === "retry" ? 1000 : null,
			extra: { ...common, ...rest, retryable: undefined, state: w.state },
			warnings,
			hint:
				retryable === "reread"
					? "the file is not what you think it is; read it again and rebuild the write from what it actually contains"
					: retryable === "retry"
						? "nothing was committed; sending the same content again is safe"
						: null,
			next_action: retryable === "reread" ? `read_file(env_id: "${envId}", path: ...)` : null,
		}),
	}
}

/** Per-platform one-liners. The shell is the runner's default for that OS. */
function listCommand(platform: Platform, path: string): string {
	if (platform === "windows") {
		// -Force includes hidden entries, the way -A does on posix.
		return (
			`Get-ChildItem -Force -LiteralPath ${pwshQuote(path)} | Sort-Object Name | ` +
			`ForEach-Object { if ($_.PSIsContainer) { "$($_.Name)/" } else { $_.Name } }`
		)
	}
	// -1 one per line, -A everything but . and .., -p marks directories with /.
	return `LC_ALL=C ls -1Ap -- ${posixQuote(path)}`
}

function base64Command(platform: Platform, path: string): string {
	if (platform === "windows") {
		return `[Convert]::ToBase64String([IO.File]::ReadAllBytes(${pwshQuote(path)}))`
	}
	if (platform === "macos") return `base64 -b 0 -i ${posixQuote(path)}`
	return `base64 -w 0 -- ${posixQuote(path)}`
}

/** Magic bytes, because a file extension is a claim and this is evidence. */
function sniffImage(b: Uint8Array): string | null {
	const at = (i: number) => b[i] ?? -1
	if (b.length >= 8 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return "image/png"
	if (b.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg"
	if (b.length >= 6 && at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46) return "image/gif"
	if (b.length >= 12 && at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(8) === 0x57 && at(9) === 0x45) {
		return "image/webp"
	}
	if (b.length >= 2 && at(0) === 0x42 && at(1) === 0x4d) return "image/bmp"
	if (b.length >= 4 && ((at(0) === 0x49 && at(1) === 0x49) || (at(0) === 0x4d && at(1) === 0x4d))) return "image/tiff"
	if (b.length >= 12 && at(4) === 0x66 && at(5) === 0x74 && at(6) === 0x79 && at(7) === 0x70) {
		const brand = String.fromCharCode(at(8), at(9), at(10), at(11))
		if (brand === "avif" || brand === "avis") return "image/avif"
	}
	return null
}


const MIME_BY_EXTENSION: Record<string, string> = {
	"7z": "application/x-7z-compressed",
	aac: "audio/aac",
	avi: "video/x-msvideo",
	bmp: "image/bmp",
	bz2: "application/x-bzip2",
	css: "text/css",
	csv: "text/csv",
	doc: "application/msword",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	epub: "application/epub+zip",
	flac: "audio/x-flac",
	gif: "image/gif",
	gz: "application/gzip",
	gzip: "application/gzip",
	heic: "image/heic",
	htm: "text/html",
	html: "text/html",
	ico: "image/vnd.microsoft.icon",
	jpeg: "image/jpeg",
	jpg: "image/jpeg",
	js: "application/javascript",
	json: "application/json",
	m4a: "audio/mp4",
	markdown: "text/markdown",
	md: "text/markdown",
	mkv: "video/x-matroska",
	mov: "video/quicktime",
	mp3: "audio/mpeg",
	mp4: "video/mp4",
	odp: "application/vnd.oasis.opendocument.presentation",
	ods: "application/vnd.oasis.opendocument.spreadsheet",
	odt: "application/vnd.oasis.opendocument.text",
	ogg: "audio/ogg",
	opus: "audio/ogg",
	pdf: "application/pdf",
	png: "image/png",
	ppt: "application/vnd.ms-powerpoint",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	py: "text/x-python",
	rar: "application/vnd.rar",
	rtf: "application/rtf",
	svg: "image/svg+xml",
	tar: "application/x-tar",
	tif: "image/tiff",
	tiff: "image/tiff",
	ts: "application/typescript",
	tsv: "text/tab-separated-values",
	txt: "text/plain",
	wav: "audio/wav",
	webm: "video/webm",
	webp: "image/webp",
	xls: "application/vnd.ms-excel",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	xml: "application/xml",
	yaml: "text/yaml",
	yml: "text/yaml",
	zip: "application/zip",
}

function fileNameFromPath(given: string): string {
	const parts = given.replace(/\\/g, "/").split("/").filter(Boolean)
	return parts[parts.length - 1] || "download.bin"
}

function hasPrefix(bytes: Uint8Array, prefix: number[]): boolean {
	return prefix.every((value, index) => bytes[index] === value)
}

function sniffFileMime(bytes: Uint8Array, fileName: string): string {
	const image = sniffImage(bytes)
	if (image) return image

	const ext = fileName.includes(".") ? fileName.split(".").pop()!.toLowerCase() : ""
	const extensionMime = MIME_BY_EXTENSION[ext]
	if (hasPrefix(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"
	if (hasPrefix(bytes, [0x1f, 0x8b])) return "application/gzip"
	if (hasPrefix(bytes, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return "application/x-7z-compressed"
	if (hasPrefix(bytes, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])) return "application/vnd.rar"
	if (hasPrefix(bytes, [0x50, 0x4b, 0x03, 0x04])) {
		// Office Open XML and EPUB are ZIP containers; the extension carries the
		// useful subtype while the signature proves that it is at least a ZIP.
		return extensionMime || "application/zip"
	}
	if (
		bytes.length >= 12 &&
		hasPrefix(bytes, [0x52, 0x49, 0x46, 0x46]) &&
		bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45
	) return "audio/wav"
	if (bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
		return extensionMime || "video/mp4"
	}
	return extensionMime || "application/octet-stream"
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes)
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

export function buildFsTools(env: Bindings, cfg: BrokerConfig): ToolDef[] {
	const readFile: ToolDef = {
		name: "read_file",
		title: "Read a text file",
		description:
			"Read a UTF-8 text file from the environment. Addressed two ways at once: offset/limit select lines (a negative offset reads the tail), from_byte/max_bytes bound how much is transferred. Line numbers are never mixed into the text. " +
			"Returns base_sha, the sha256 of the whole file, which write_file uses to refuse a write built on a stale read. " +
			"End of file is the ABSENCE of next_byte; while next_byte is present there is more to read. " +
			"Binary files and invalid UTF-8 are refused rather than mangled -- use get_file to return the original, or get_image when the client should inspect an image. " +
			"CRLF and a leading BOM are measured and reported, never silently normalised.",
		inputSchema: ReadFileInput,
		readOnly: true,
		async handler(args: ReadFileArgs, ctx) {
			const r = await fileJob(
				env,
				args.env_id,
				"read",
				{
					path: args.path,
					offset: numArg(args.offset, 0),
					limit: clamp(numArg(args.limit, 2000), 1, 100000),
					from_byte: Math.max(0, numArg(args.from_byte, 0)),
					max_bytes: clamp(numArg(args.max_bytes, 65536), 1024, READ_MAX_BYTES),
				},
				args.deadline_ms,
				ctx,
			)
			if (!r.ok) return r.payload
			return ok(r.data, { warnings: r.warnings })
		},
	}

	const writeFile: ToolDef = {
		name: "write_file",
		title: "Write a file and show the diff",
		description:
			"Replace a file's contents with `content` and report what changed: `summary` is local-mcp's `Edited <path> (+added -removed)` line and `diff` is a unified diff at 3 lines of context. " +
			"The file is read immediately beforehand, so the write is conditional on what was actually there: if it changed in between, the write is refused with sha_mismatch instead of overwriting someone else's edit. A file that does not exist yet is created. " +
			"The write itself is atomic -- temp file in the same directory, fsync, chmod to the old mode, rename over the target -- so a reader sees the whole old file or the whole new one, and a crash mid-write leaves the original intact. " +
			"Retrying with identical arguments replays the recorded result rather than applying it twice. " +
			"Text only, and it replaces the whole file: for binary or for appending, use execute.",
		inputSchema: WriteFileInput,
		async handler(args: WriteFileArgs, ctx) {
			const envId = args.env_id
			const bytes = new TextEncoder().encode(args.content)
			const contentB64 = b64encode(bytes)
			if (contentB64.length > WRITE_MAX_B64) {
				return fail("bad_input", `content is too large to send in one job (${bytes.length} bytes)`, {
					hint: "one queue entry has to fit in the durable object; write it in pieces with execute",
					next_action: "execute",
				})
			}

			const warnings: string[] = []
			let oldText: string | null = null
			let baseSha: string | null = args.base_sha ?? null

			// The read is what makes the diff possible AND what makes the write
			// conditional. Its failure is never fatal: a file that cannot be read can
			// still be written, it just cannot be diffed.
			const pre = await fileJob(
				env,
				envId,
				"read",
				{ path: args.path, offset: 0, limit: 1_000_000, from_byte: 0, max_bytes: READ_MAX_BYTES },
				args.deadline_ms,
				ctx,
			)
			if (pre.ok) {
				const partial = Boolean(pre.data.truncated) || pre.data.next_byte !== undefined
				if (partial) {
					warnings.push("the file was too large to read in one window, so no diff is shown for this write")
					baseSha = baseSha ?? (typeof pre.data.base_sha === "string" ? pre.data.base_sha : null)
				} else {
					oldText = String(pre.data.text ?? "")
					baseSha = baseSha ?? (typeof pre.data.base_sha === "string" ? pre.data.base_sha : null)
				}
			} else if (pre.code === "not_found") {
				// A new file. SHA256_EMPTY as base_sha means "must not exist yet", which
				// turns the gap between this read and the write into a refusal rather
				// than a silent overwrite of something created in between.
				oldText = ""
				baseSha = baseSha ?? SHA256_EMPTY
			} else if (pre.code === "still_running" || pre.code === "env") {
				return pre.payload
			} else {
				warnings.push(`the file could not be read before writing (${pre.code}), so no diff is shown`)
			}

			const res = await fileJob(
				env,
				envId,
				"write",
				{
					path: args.path,
					content_b64: contentB64,
					base_sha: baseSha,
					create_parents: Boolean(args.create_parents),
				},
				args.deadline_ms,
				ctx,
			)
			if (!res.ok) return res.payload

			const d = oldText === null ? null : unifiedDiff(oldText, args.content)
			if (d?.truncated) warnings.push("the diff was too large to lay out in full; the counts are still exact")

			const summary =
				d === null
					? `Wrote ${args.path}`
					: d.identical
						? `Edited ${args.path} (no change)`
						: `Edited ${args.path} (+${d.added} -${d.removed})`

			return ok(
				{
					...res.data,
					summary,
					lines_added: d?.added ?? null,
					lines_removed: d?.removed ?? null,
					diff: d?.diff ?? null,
				},
				{
					warnings: [...res.warnings, ...warnings],
					hint:
						d && d.identical
							? "the file already had exactly this content, so nothing changed on disk"
							: null,
				},
			)
		},
	}

	const listDirectory: ToolDef = {
		name: "list_directory",
		title: "List a directory",
		description:
			"List the immediate entries of a directory, sorted, with directories marked by a trailing slash. Hidden entries are included. This does not recurse: for a tree, or for sizes and timestamps, run find or ls -la through execute.",
		inputSchema: ListDirectoryInput,
		readOnly: true,
		async handler(args: ListDirectoryArgs, ctx) {
			const envId = args.env_id
			const platform = platformOf(envId)
			const deadlineMs = clamp(numArg(args.deadline_ms, 20000), 1000, 45000)

			const cap = await runCapture(
				env,
				cfg,
				envId,
				listCommand(platform, args.path),
				{
					label: "list_directory",
					timeoutS: 60,
					deadlineMs,
					maxChars: 1_000_000,
					note: "listing the directory",
				},
				ctx,
			)
			if (!cap.ok) return cap.payload

			if (cap.exitCode !== 0) {
				const why = cap.text.trim().slice(0, 300)
				const missing = /No such file|cannot find|does not exist/i.test(why)
				return fail(missing ? "not_found" : "io_error", why || `the directory could not be listed (exit ${cap.exitCode})`, {
					on_error: "stop",
					extra: { env_id: envId, job_id: cap.jobId, path: args.path, exit_code: cap.exitCode },
					warnings: cap.warnings,
					hint: missing ? "check the path; relative paths resolve against the sticky cwd" : null,
				})
			}

			const entries = cap.text
				.split("\n")
				.map((l) => l.replace(/\r$/, ""))
				.filter((l) => l !== "")

			return ok(
				{
					env_id: envId,
					job_id: cap.jobId,
					platform,
					path: args.path,
					entries,
					count: entries.length,
				},
				{ warnings: cap.warnings },
			)
		},
	}

	const getImage: ToolDef = {
		name: "get_image",
		title: "Read an image file",
		description:
			"Read an image out of the environment and return it as native image content -- use this for screenshots, plots and rendered output. " +
			"The format is detected from magic bytes. For compatibility with clients that cached the older tool catalog, a non-image is returned as a native embedded resource, the same payload as get_file. " +
			"Images keep the roughly 1.5 MB ceiling; generic embedded files can be up to 5 MiB.",
		inputSchema: GetImageInput,
		readOnly: true,
		async handler(args: GetImageArgs, ctx) {
			const envId = args.env_id
			const platform = platformOf(envId)
			const deadlineMs = clamp(numArg(args.deadline_ms, 30000), 1000, 45000)

			const cap = await runCapture(
				env,
				cfg,
				envId,
				base64Command(platform, args.path),
				{
					label: "get_image",
					timeoutS: 120,
					deadlineMs,
					maxChars: MAX_FILE_B64_CHARS,
					note: "encoding the file on the runner",
				},
				ctx,
			)
			if (!cap.ok) return cap.payload

			if (cap.exitCode !== 0) {
				const why = cap.text.trim().slice(0, 300)
				const missing = /No such file|cannot find|does not exist/i.test(why)
				return fail(missing ? "not_found" : "io_error", why || `the file could not be read (exit ${cap.exitCode})`, {
					on_error: "stop",
					extra: { env_id: envId, job_id: cap.jobId, path: args.path, exit_code: cap.exitCode },
					warnings: cap.warnings,
				})
			}

			// The stream is stdout and stderr merged, so anything the platform command
			// printed to stderr is sitting in the middle of the base64. Refusing on a
			// stray character is the only safe read: silently dropping it would decode
			// to a subtly corrupt image.
			const data = cap.text.replace(/[\s\uFEFF]+/g, "")
			if (data && !/^[A-Za-z0-9+/=]+$/.test(data)) {
				return fail("io_error", "the encoder wrote something other than base64, so the image cannot be trusted", {
					on_error: "stop",
					extra: { env_id: envId, job_id: cap.jobId, path: args.path, output_head: cap.text.slice(0, 200) },
					warnings: cap.warnings,
					hint: "read the job's output with poll_job to see what the runner printed",
				})
			}

			let raw: Uint8Array
			try {
				raw = b64decode(data)
			} catch {
				return fail("io_error", "the base64 the runner produced did not decode", {
					on_error: "stop",
					extra: { env_id: envId, job_id: cap.jobId, path: args.path },
					warnings: cap.warnings,
				})
			}

			const mime = sniffImage(raw)
			if (!mime) {
				const fileName = fileNameFromPath(args.path)
				const fileMime = sniffFileMime(raw, fileName)
				const sha256 = await sha256Bytes(raw)
				const uri = `gha-mcp://file/${encodeURIComponent(envId)}/${encodeURIComponent(fileName)}`
				return ok(
					{
						env_id: envId,
						job_id: cap.jobId,
						platform,
						path: args.path,
						file_name: fileName,
						mime_type: fileMime,
						bytes: raw.length,
						sha256,
						uri,
						compatibility_route: "get_image",
						[MCP_CONTENT_KEY]: [{ type: "resource", resource: { uri, mimeType: fileMime, blob: data } }],
					},
					{
						warnings: [
							...cap.warnings,
							"this client used the get_image compatibility route; refresh the MCP connection to expose get_file directly",
						],
					},
				)
			}

			if (data.length > MAX_IMAGE_B64_CHARS) {
				return fail("bad_input", "the image is too large to return as native image content", {
					on_error: "stop",
					extra: { env_id: envId, path: args.path, bytes: raw.length },
					warnings: cap.warnings,
					hint: "downscale the image on the runner, or rename it only if it should be treated as a generic file",
					next_action: "execute",
				})
			}

			return ok(
				{
					env_id: envId,
					job_id: cap.jobId,
					platform,
					path: args.path,
					mime_type: mime,
					bytes: raw.length,
					// The image rides as a native MCP content item; mcp.ts moves this key
					// into `content` and keeps it out of structuredContent, so megabytes
					// of base64 never appear twice in one response.
					[MCP_CONTENT_KEY]: [{ type: "image", data, mimeType: mime }],
				},
				{ warnings: cap.warnings },
			)
		},
	}


	const getFile: ToolDef = {
		name: "get_file",
		title: "Return a file to the MCP client",
		description:
			"Read any file out of the environment and return its bytes as a native MCP embedded resource, so the client can present or save the original file instead of base64 text. " +
			"The filename defaults to the path basename and the MIME type is detected from magic bytes and extension; either can be overridden. " +
			"The whole file travels inline in one response and is integrity-checked with SHA-256. The ceiling is 5 MiB; for a larger artifact, split or shrink it first.",
		inputSchema: GetFileInput,
		readOnly: true,
		async handler(args: GetFileArgs, ctx) {
			const envId = args.env_id
			const platform = platformOf(envId)
			const deadlineMs = clamp(numArg(args.deadline_ms, 30000), 1000, 45000)

			const cap = await runCapture(
				env,
				cfg,
				envId,
				base64Command(platform, args.path),
				{
					label: "get_file",
					timeoutS: 180,
					deadlineMs,
					maxChars: MAX_FILE_B64_CHARS,
					note: "encoding the file on the runner",
				},
				ctx,
			)
			if (!cap.ok) return cap.payload

			if (cap.exitCode !== 0) {
				const why = cap.text.trim().slice(0, 300)
				const missing = /No such file|cannot find|does not exist/i.test(why)
				return fail(missing ? "not_found" : "io_error", why || `the file could not be read (exit ${cap.exitCode})`, {
					on_error: "stop",
					extra: { env_id: envId, job_id: cap.jobId, path: args.path, exit_code: cap.exitCode },
					warnings: cap.warnings,
				})
			}

			const data = cap.text.replace(/[\s\uFEFF]+/g, "")
			if (data && !/^[A-Za-z0-9+/=]+$/.test(data)) {
				return fail("io_error", "the encoder wrote something other than base64, so the file cannot be trusted", {
					on_error: "stop",
					extra: { env_id: envId, job_id: cap.jobId, path: args.path, output_head: cap.text.slice(0, 200) },
					warnings: cap.warnings,
					hint: "read the job's output with poll_job to see what the runner printed",
				})
			}

			let raw: Uint8Array
			try {
				raw = b64decode(data)
			} catch {
				return fail("io_error", "the base64 the runner produced did not decode", {
					on_error: "stop",
					extra: { env_id: envId, job_id: cap.jobId, path: args.path },
					warnings: cap.warnings,
				})
			}
			if (raw.length > MAX_FILE_BYTES) {
				return fail("bad_input", `the file is ${raw.length} bytes; get_file supports at most ${MAX_FILE_BYTES}`, {
					on_error: "stop",
					extra: { env_id: envId, job_id: cap.jobId, path: args.path, bytes: raw.length, limit_bytes: MAX_FILE_BYTES },
					warnings: cap.warnings,
					hint: "split or shrink the file on the runner, then call get_file again",
					next_action: "execute",
				})
			}

			const fileName = args.file_name || fileNameFromPath(args.path)
			const mime = args.mime_type || sniffFileMime(raw, fileName)
			const sha256 = await sha256Bytes(raw)
			const uri = `gha-mcp://file/${encodeURIComponent(envId)}/${encodeURIComponent(fileName)}`

			return ok(
				{
					env_id: envId,
					job_id: cap.jobId,
					platform,
					path: args.path,
					file_name: fileName,
					mime_type: mime,
					bytes: raw.length,
					sha256,
					uri,
					// The bytes ride once as a native MCP embedded resource. They do not
					// appear in structuredContent or in the JSON text copy.
					[MCP_CONTENT_KEY]: [{ type: "resource", resource: { uri, mimeType: mime, blob: data } }],
				},
				{ warnings: cap.warnings },
			)
		},
	}

	return [readFile, writeFile, listDirectory, getImage, getFile]
}
