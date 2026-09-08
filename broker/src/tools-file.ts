/* File jobs share the existing queue and raw-byte output transport. Multiple
 * exec worker processes can run concurrently; the queue is not a per-env mutex.
 * Pending results are retrieved with file_result, not by resubmitting mutations.
 * Atomic replacement and base_sha prechecks do not constitute a cross-process
 * transaction. See FILE_TOOLS.md for limits and recovery rules.
 */

import { z } from "zod"

import type { BrokerConfig } from "./config"
import type { ToolDef } from "./mcp"
import { collectFileResult } from "./file-result"
import { clamp, fail, numArg } from "./result"
import { type Bindings, envStub, sha256Hex } from "./tools-shared"

/** Bound source bytes per text read; JSON may span multiple result windows. */
const READ_MAX_BYTES = 131_072
/** Ceiling on base64 content, so one queue entry stays under the DO's 2MB. */
const WRITE_MAX_B64 = 700_000
const STR_MAX = 65_536

// Mirrors ENV_ID_RE in schemas.ts. Kept local so adding file tools does not
// touch the exec schemas.
const EnvIdField = z
	.string()
	.regex(/^(linux|mac|win)-[0-9a-hjkmnp-tv-z]{8}$/, "env_id must look like linux-ab12cd34")
const PathField = z.string().min(1).max(4096)

export const FileReadInput = z.strictObject({
	env_id: EnvIdField,
	path: PathField,
	cwd: PathField.optional(),
	offset: z.number().optional(),
	limit: z.number().optional(),
	from_byte: z.number().optional(),
	max_bytes: z.number().optional(),
	deadline_ms: z.number().optional(),
})

export const FileWriteInput = z.strictObject({
	env_id: EnvIdField,
	path: PathField,
	cwd: PathField.optional(),
	content_b64: z.string().optional(),
	content: z.string().optional(),
	base_sha: z.string().optional(),
	create_parents: z.boolean().optional(),
	deadline_ms: z.number().optional(),
})

export const FileEditInput = z.strictObject({
	env_id: EnvIdField,
	path: PathField,
	cwd: PathField.optional(),
	old_str: z.string().min(1),
	new_str: z.string(),
	expected_replacements: z.number().optional(),
	dry_run: z.boolean().optional(),
	base_sha: z.string().optional(),
	deadline_ms: z.number().optional(),
})

type JobArgs = Record<string, unknown>

export async function submitFile(
	env: Bindings,
	envId: string,
	op: string,
	jobArgs: JobArgs,
	deadlineMsRaw: unknown,
	ctx: { signal: AbortSignal; note: (m: string) => void },
): Promise<Record<string, unknown>> {
	const stub = envStub(env, envId)

	const snap = await stub.snapshot(false)
	if (!snap.env_id) return fail("env_not_found", `no environment ${envId}`, { next_action: "env_list" })
	if (snap.state === "provisioning") {
		return fail("enroll_race", "the runner has not enrolled yet", {
			retry_after_ms: 3000,
			next_action: `env_status(env_id: "${envId}", wait_ready_ms: 45000)`,
		})
	}
	if (snap.state !== "ready") {
		return fail(snap.state === "expired" ? "env_expired" : "env_not_found", `environment is ${snap.state}`, {
			extra: { failure_reason: snap.failure_reason ?? null },
			next_action: "env_create",
		})
	}

	const warnings: string[] = [...((snap.warnings as string[]) || [])]
	const deadlineMs = clamp(numArg(deadlineMsRaw, 20000), 1000, 45000)
	const commandId = crypto.randomUUID().replace(/-/g, "").slice(0, 16)

	// write_id is derived from the arguments on the SERVER, not supplied by the
	// caller: an LLM that retries a write does not reliably resend the same id,
	// and it is exactly that retry we are trying to make idempotent. Identical
	// arguments therefore replay the recorded result instead of writing twice.
	jobArgs = { ...jobArgs, cwd: jobArgs.cwd ?? snap.sticky_cwd ?? null }
	const wireSize = new TextEncoder().encode(JSON.stringify(jobArgs)).length
	if (wireSize > 1_000_000) return fail("bad_input", "File job exceeds its serialized request budget; split the input")
	const writeId = await sha256Hex(JSON.stringify([envId, op, jobArgs]))
	const mutating = ["write", "edit"].includes(op) && !jobArgs.dry_run

	const payload = { command_id: commandId, type: "file", op, write_id: writeId, ...jobArgs }

	const enq = await stub.enqueue({
		command_id: commandId,
		idem_hash: mutating ? `key:file:${writeId}` : `nodedupe:${commandId}`,
		payload,
		label: `file_${op}`,
		cwd: null,
		shell: null,
		maxQueue: 8,
		idemWindowMs: deadlineMs + 60_000,
	})
	if (!enq.ok) {
		return fail("runner_busy_queue_full", `the runner already has ${enq.queue_depth} jobs queued (max ${enq.max_queue})`, {
			retry_after_ms: 2000,
			hint: "file jobs share the queue with exec; wait for one to finish",
			next_action: "exec_read on an earlier command_id",
		})
	}
	if (enq.deduped) {
		warnings.push("an identical file job was already submitted; returning that one instead of applying it twice")
	}

	return collectFileResult(env, envId, enq.command_id, deadlineMs, ctx, op, warnings)
}

export function buildFileTools(env: Bindings, _cfg: BrokerConfig): ToolDef[] {
	const fileRead: ToolDef = {
		name: "file_read",
		title: "Read a text file",
		description:
			"Read a UTF-8 text file from the environment. Addressed two ways at once: `offset`/`limit` select lines (a negative offset reads the tail), " +
			"`from_byte`/`max_bytes` bound how much is transferred. Line numbers are never mixed into the text. " +
			"Returns base_sha, the sha256 of the whole file -- pass it back to file_write or file_edit and the write is refused if the file changed in between. " +
			"End of file is signalled by the ABSENCE of next_byte; while next_byte is present there is more to read. " +
			"Binary files and invalid UTF-8 are refused; use file_read_image for PNG/JPEG. UTF-8 byte windows extend at most 3 bytes to finish a character. " +
			"CRLF and a leading BOM are measured and reported, never silently normalised.",
		inputSchema: FileReadInput,
		readOnly: true,
		async handler(args, ctx) {
			const maxBytes = clamp(numArg(args.max_bytes, 65536), 1024, READ_MAX_BYTES)
			return submitFile(
				env,
				args.env_id,
				"read",
				{
					path: args.path,
					cwd: args.cwd,
					offset: numArg(args.offset, 0),
					limit: clamp(numArg(args.limit, 2000), 1, 100000),
					from_byte: Math.max(0, numArg(args.from_byte, 0)),
					max_bytes: maxBytes,
				},
				args.deadline_ms,
				ctx,
			)
		},
	}

	const fileWrite: ToolDef = {
		name: "file_write",
		title: "Write a file atomically",
		description:
			"Replace a file's contents. Provide exactly one of content (plain UTF-8, up to 512 KiB) or content_b64 (arbitrary bytes). Use explicit cwd for relative paths. " +
			"The write is atomic: a temp file in the SAME directory is written, fsynced, chmod'd to the old file's mode, then renamed over the target. " +
			"A reader therefore sees either the whole old file or the whole new one, never a half-written file, and a crash mid-write leaves the original intact. " +
			"Pass base_sha from file_read to make this conditional: if the file changed since you read it the write is refused with sha_mismatch instead of overwriting someone else's change. " +
			"If result_pending is true, retrieve the same command_id with file_result; never resubmit a pending write. Identical retries are deduplicated within the short replay window. " +
			"Set create_parents to create missing directories. For files larger than the limit, write in pieces with exec, or use exec redirection.",
		inputSchema: FileWriteInput,
		async handler(args, ctx) {
			if ((typeof args.content === "string") === (typeof args.content_b64 === "string")) return fail("bad_input", "Provide exactly one of content (UTF-8) or content_b64")
			if (args.content !== undefined && new TextEncoder().encode(args.content).length > 524288) return fail("bad_input", "content exceeds 512 KiB")
			if (String(args.content_b64 || "").length > WRITE_MAX_B64) {
				return fail("bad_input", `content_b64 is longer than ${WRITE_MAX_B64} characters`, {
					hint: "one queue entry has to fit in the durable object; split the write or use exec with base64 -d",
					next_action: "exec",
				})
			}
			return submitFile(
				env,
				args.env_id,
				"write",
				{
					path: args.path,
					cwd: args.cwd,
					...(args.content === undefined ? { content_b64: args.content_b64 } : { content: args.content }),
					base_sha: args.base_sha ?? null,
					create_parents: Boolean(args.create_parents),
				},
				args.deadline_ms,
				ctx,
			)
		},
	}

	const fileEdit: ToolDef = {
		name: "file_edit",
		title: "Replace exact text in a file",
		description:
			"Replace old_str with new_str in a text file. Matching is EXACT and literal -- no regex, no fuzzy matching, no whitespace tolerance -- because a near miss that edits the wrong line is worse than a failure. " +
			"old_str must occur exactly expected_replacements times (default 1); any other count is refused and nothing is written, so ambiguity never silently picks a match. " +
			"Include enough surrounding context to make the match unique. dry_run=true validates the edit and returns a bounded diff without writing. Explicit cwd avoids sticky-directory races. " +
			"$& and $1 inside new_str are literal. CRLF line endings and a leading BOM are preserved. " +
			"The write-back is atomic (temp + rename in the same directory) and pass base_sha from file_read to refuse the edit if the file moved under you. " +
			"If result_pending is true, retrieve the same command_id with file_result; never resubmit a pending mutation. Identical retries are deduplicated within the documented short replay window.",
		inputSchema: FileEditInput,
		async handler(args, ctx) {
			if (String(args.old_str).length > STR_MAX || String(args.new_str).length > STR_MAX) {
				return fail("bad_input", `old_str and new_str must each be at most ${STR_MAX} characters`, {
					hint: "for a change this large, write the whole file with file_write",
					next_action: "file_write",
				})
			}
			return submitFile(
				env,
				args.env_id,
				"edit",
				{
					path: args.path,
					cwd: args.cwd,
					old_str: args.old_str,
					new_str: args.new_str,
					expected_replacements: clamp(numArg(args.expected_replacements, 1), 1, 10000),
					dry_run: Boolean(args.dry_run),
					base_sha: args.base_sha ?? null,
				},
				args.deadline_ms,
				ctx,
			)
		},
	}

	return [fileRead, fileWrite, fileEdit]
}
