import { b64decode, renderWindow } from "./bytes"
import { ID_PREFIX, type Platform } from "./config"
import { ok } from "./result"

export type Bindings = {
	ENV_DO: DurableObjectNamespace
	GUARD_DO: DurableObjectNamespace
	GITHUB_PAT_DISPATCH: string
} & Record<string, unknown>

/** Crockford-ish base32: no i, l, o or u, so an id is never misread aloud. */
const BASE32 = "0123456789abcdefghjkmnpqrstvwxyz"

export function newEnvId(platform: Platform): string {
	const raw = new Uint8Array(8)
	crypto.getRandomValues(raw)
	let s = ""
	for (const b of raw) s += BASE32[b % 32]
	return `${ID_PREFIX[platform]}-${s}`
}

export function platformOf(envId: string): Platform {
	if (envId.startsWith("mac-")) return "macos"
	if (envId.startsWith("win-")) return "windows"
	return "linux"
}

export function guard(env: Bindings) {
	return env.GUARD_DO.get(env.GUARD_DO.idFromName("singleton")) as any
}

export function envStub(env: Bindings, envId: string) {
	return env.ENV_DO.get(env.ENV_DO.idFromName(envId)) as any
}

export async function sha256Hex(s: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

export type PollError = { code: string; message: string; retryable: boolean } | null

/**
 * Every Durable Object hop can fail transiently. A transient failure is
 * `poll_error`, which is always distinct from `lost`: `lost` is a confirmed
 * conclusion about the command, `poll_error` is a statement about the broker.
 * Collapsing the two is how "state: unknown" was born in the old system.
 *
 * `value` is typed `any`, not `T | null`, deliberately. Every caller passes a
 * Durable Object stub method, and stub calls are untyped across the RPC
 * boundary: tsc finds no inference candidate for T there and falls back to the
 * empty object type, which then rejects every property read on the result. The
 * stub's own wire contract is the type boundary here, not this helper.
 */
export async function tryCall<T = any>(
	fn: () => Promise<T>,
): Promise<{ value: any; pollError: PollError }> {
	try {
		return { value: await fn(), pollError: null }
	} catch (e: any) {
		return {
			value: null,
			pollError: {
				code: "do_unavailable",
				message: String(e?.message || e).slice(0, 200),
				retryable: true,
			},
		}
	}
}

export type ReturnedBecause = "exit" | "idle" | "deadline" | "cap" | "queued"

/** The runner's own vocabulary. `queued` and `running` are the live ones. */
const TERMINAL_STATES = new Set(["exited", "killed", "lost"])

export function isTerminal(state: unknown): boolean {
	return TERMINAL_STATES.has(String(state))
}

/**
 * The coarse status the caller branches on, which is the one local-mcp's
 * clients already know: anything that is not finished is "running", including a
 * job still queued behind another. The precise runner state stays alongside it
 * as `state`, so nothing is lost by simplifying.
 */
export type JobStatus = "running" | "exited" | "killed" | "lost"

export function statusOf(state: unknown): JobStatus {
	const s = String(state)
	if (s === "exited" || s === "killed" || s === "lost") return s
	return "running"
}

export type RenderedText = {
	text: string
	/** Raw bytes covered. Add it to from_byte to get next_byte. Not text.length. */
	rawBytes: number
	partialLineDropped: boolean
	forcedSplit: boolean
	/** False when the window held bytes back, so eof cannot be claimed yet. */
	fullyConsumed: boolean
}

/**
 * THE cut site. renderWindow() is called here and nowhere else in the Worker,
 * and broker-ci enforces that with a grep, because two places that decide where
 * a window ends cannot be kept in agreement -- and the moment they disagree,
 * re-reading the same offset stops returning the same bytes.
 */
export function renderText(bytesB64: unknown, eof: boolean, redact?: (s: string) => string): RenderedText {
	const raw = b64decode(String(bytesB64 || ""))
	const rendered = renderWindow(raw, { eof, redact })
	return {
		text: rendered.text,
		rawBytes: rendered.rawBytes,
		partialLineDropped: rendered.partialLineDropped,
		forcedSplit: rendered.forcedSplit,
		fullyConsumed: rendered.rawBytes >= raw.length,
	}
}

/**
 * execute, start_command, poll_job and stop_job's follow-up all return the
 * identical key set, always, with every field present. A field that appears
 * only in the interesting case forces the caller to branch on key existence,
 * and a caller that guesses wrong reports "state: unknown" instead of what
 * actually happened.
 *
 * Note what is NOT split here: stdout and stderr. The runner gives the child a
 * single appending file descriptor for both, which is what removes the pipe
 * deadlock this system was built to avoid, so `output` is the interleaved
 * stream exactly as the command wrote it. local-mcp returns them separately;
 * that difference is deliberate and cannot be undone downstream.
 */
export function jobResult(a: {
	jobId: string
	envId: string
	platform: Platform
	w: any | null
	returnedBecause: ReturnedBecause
	pollError: PollError
	warnings: string[]
	deduped: boolean
	queuePosition: number
	queueDepth: number
	overlayVersion: number
	runnerGone: boolean
	stickyCwd: string | null
	redact?: (s: string) => string
}) {
	const w = a.w
	const state = (w?.state as string) || "queued"
	const terminal = isTerminal(state)
	const idleSeconds =
		w?.last_output_at != null ? Math.max(0, Math.floor((Date.now() - w.last_output_at) / 1000)) : 0

	const startByte = Number(w?.start_byte ?? 0)
	const rendered = renderText(w?.bytes_b64, Boolean(w?.eof), a.redact)
	const nextByte = startByte + rendered.rawBytes
	const eof = Boolean(w?.eof) && rendered.fullyConsumed

	const headDiscarded = Number(w?.head_discarded_bytes ?? 0)
	const outputCapped = Boolean(w?.output_capped)

	const warnings = [...a.warnings]
	// Warnings the runner attached to the command rather than to one chunk, kept
	// on the row so that a re-read reports them too instead of them being visible
	// only to whoever happened to read the chunk that carried them. This is also
	// where the runner's agent_error arrives for a command that never started.
	for (const cw of (w?.command_warnings ?? []) as unknown[]) {
		if (typeof cw === "string" && cw) warnings.push(cw)
	}
	if (rendered.partialLineDropped) {
		warnings.push("a trailing partial line was withheld; the next poll_job starts exactly there")
	}
	if (rendered.forcedSplit) {
		warnings.push(
			"an escape sequence longer than the 4KiB lookback had to be split to keep the reader moving, so a few control characters may show up literally in this window",
		)
	}
	if (w?.range_evicted) {
		warnings.push(
			`bytes before ${w.available_from_byte} are no longer buffered in the broker; poll_job pulls them from the runner on demand`,
		)
	}
	if (headDiscarded > 0) {
		warnings.push(
			`${headDiscarded} bytes were skipped: they have aged out of the broker's buffer and the runner is no longer there to re-serve them. This window starts at byte ${startByte}.`,
		)
	}
	if (outputCapped) {
		warnings.push(
			"this command hit its output cap and was killed for it, so the output ends where the cap was, not where the command would have. If the tail is what matters, run it again through tail.",
		)
	}
	if (!terminal && idleSeconds >= 300) {
		warnings.push(`no output for ${idleSeconds}s; the command may be waiting on input it will never get`)
	}

	let hint: string | null = null
	let nextAction: string | null = null
	if (state === "lost") {
		// The runner's own agent_error reaches the warnings above now, so most lost
		// jobs explain themselves. This must therefore NOT lead with "retry": a
		// precondition that failed -- a program that is not installed, a cwd that
		// cannot be created -- is permanent, and "just run it again" turns that
		// into an infinite loop.
		hint =
			"the runner cannot account for this job. Read the warnings and output first: if they name a precondition that failed, it is permanent and re-running changes nothing. An unexplained lost means the runner died between claiming and spawning, and only then is re-running reasonable -- and only for an idempotent command."
		nextAction = `poll_job(env_id: "${a.envId}", job_id: "${a.jobId}", from_byte: 0)`
	} else if (state === "queued") {
		hint = `queued behind ${a.queuePosition} job(s); nothing is wrong, the runner is busy`
		nextAction = `poll_job(env_id: "${a.envId}", job_id: "${a.jobId}", from_byte: 0, until: "any_output")`
	} else if (!terminal) {
		hint = "still running; resume from next_byte"
		nextAction = `poll_job(env_id: "${a.envId}", job_id: "${a.jobId}", from_byte: ${nextByte}, until: "exit")`
	} else if (!eof) {
		hint = "finished, but you have not read all of the output yet"
		nextAction = `poll_job(env_id: "${a.envId}", job_id: "${a.jobId}", from_byte: ${nextByte})`
	}

	return ok(
		{
			job_id: a.jobId,
			env_id: a.envId,
			platform: a.platform,
			status: statusOf(state),
			state,
			returned_because: a.returnedBecause,
			exit_code: w?.exit_code ?? null,
			runtime_ms: w?.runtime_ms ?? null,
			idle_seconds: idleSeconds,
			cwd: w?.cwd ?? a.stickyCwd,
			output: rendered.text,
			start_byte: startByte,
			next_byte: nextByte,
			bytes_returned: rendered.rawBytes,
			total_bytes: w?.total_bytes ?? 0,
			bytes_written: w?.bytes_written ?? w?.total_bytes ?? 0,
			head_discarded_bytes: headDiscarded,
			eof,
			partial_line_dropped: rendered.partialLineDropped,
			forced_split: rendered.forcedSplit,
			output_capped: outputCapped,
			truncated: Boolean(w?.truncated),
			source: "broker_ring",
			runner_gone: a.runnerGone,
			range_evicted: Boolean(w?.range_evicted),
			available_from_byte: w?.available_from_byte ?? 0,
			killed_reason: w?.killed_reason ?? null,
			poll_error: a.pollError,
			deduped: a.deduped,
			queue_position: a.queuePosition,
			queue_depth: a.queueDepth,
			overlay_version: a.overlayVersion,
		},
		{ warnings, hint, next_action: nextAction, on_error: state === "lost" ? "reexecute_unsafe" : null },
	)
}
