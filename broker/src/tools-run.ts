/*
 * The execution lane: execute, start_command, poll_job, stop_job.
 *
 * THERE IS NO SANDBOX HERE, and that is a decision rather than an omission.
 * local-mcp confines a command with Landlock on Linux and Seatbelt on macOS,
 * and offers without_sandbox for the cases where that confinement gets in the
 * way. In this system the unit of isolation sits one level up: an environment
 * IS a throwaway GitHub Actions VM, holding nothing of ours, destroyed with the
 * job. A second, weaker boundary inside it would buy no safety and would mostly
 * produce commands that fail for reasons the caller cannot see -- so execute
 * runs the command unconfined, and without_sandbox is registered as a plain
 * alias of execute so a client written against local-mcp keeps working.
 *
 * What IS kept from the lane this replaces, because it is what makes the tools
 * usable from an MCP client at all:
 *
 *  - Nothing blocks to completion. execute waits for the foreground window
 *    (default 30s, local-mcp's own timeout) and then hands back a job_id.
 *  - Output is addressed by byte offset into the runner's raw output file, so
 *    re-reading an offset returns the same bytes forever, which is what makes a
 *    client-side timeout recoverable instead of fatal.
 *  - stdout and stderr are ONE stream. The runner hands the child a single
 *    appending file descriptor for both -- that is what removes the pipe
 *    deadlock this system exists to avoid -- so there is no point downstream
 *    where they could be separated again. local-mcp returns them apart; we
 *    cannot, and pretending otherwise would mean inventing an ordering.
 *  - A non-zero exit is data, not an error. local-mcp raises on non-zero, which
 *    throws away the output that explains why it failed.
 */

import { checkArgv, describeArgv, renderArgv } from "./argv"
import { b64decode } from "./bytes"
import type { BrokerConfig } from "./config"
import type { ToolDef } from "./mcp"
import { Deadline, SOFT_CAP_MS, clamp, fail, makePollClock, numArg, ok } from "./result"
import {
	ExecuteInput,
	PollJobInput,
	StartCommandInput,
	StopJobInput,
	WithoutSandboxInput,
	type ExecuteArgs,
	type PollJobArgs,
	type StartCommandArgs,
	type StopJobArgs,
} from "./schemas"
import {
	type Bindings,
	type PollError,
	type ReturnedBecause,
	envStub,
	isTerminal,
	jobResult,
	platformOf,
	sha256Hex,
	tryCall,
} from "./tools-shared"

/*
 * Cadence for the window probes in this lane.
 *
 * Every probe is one billed Durable Object request, and every probe re-reads
 * the SAME window -- only the last one shapes the answer. The ones in between
 * exist solely to notice an exit or a quiet period early. At a flat 300ms that
 * was ~66 requests to produce one result, and two idle long-polls plus this
 * lane put 106,857 requests on a 100,000/day free-tier ceiling in one day.
 */
const WINDOW_POLL_MIN_MS = 200
const WINDOW_POLL_MAX_MS = 2_000

/** local-mcp's FOREGROUND_TIMEOUT. Past this, a command becomes a job_id. */
export const FOREGROUND_WAIT_MS = 30_000

/** Largest window the DO will hand back in one call. */
const MAX_WINDOW_BYTES = 262_144

export type Ready = { ok: true; snap: any } | { ok: false; payload: Record<string, unknown> }

/** Shared precondition check. The three not-ready states each need a different verb. */
export async function ensureReady(stub: any, envId: string): Promise<Ready> {
	const snap = await stub.snapshot(false)
	if (!snap.env_id) {
		return { ok: false, payload: fail("env_not_found", `no environment ${envId}`, { next_action: "env_list" }) }
	}
	if (snap.state === "provisioning") {
		return {
			ok: false,
			payload: fail("enroll_race", "the runner has not enrolled yet", {
				retry_after_ms: 3000,
				next_action: `env_status(env_id: "${envId}", wait_ready_ms: 45000)`,
			}),
		}
	}
	if (snap.state !== "ready") {
		return {
			ok: false,
			payload: fail(snap.state === "expired" ? "env_expired" : "env_not_found", `environment is ${snap.state}`, {
				extra: { failure_reason: snap.failure_reason ?? null },
				next_action: "env_create",
			}),
		}
	}
	return { ok: true, snap }
}

type Enqueued =
	| { ok: false; payload: Record<string, unknown> }
	| { ok: true; jobId: string; snap: any; enq: any; warnings: string[] }

async function enqueueCommand(
	env: Bindings,
	cfg: BrokerConfig,
	a: {
		envId: string
		commandLine: string
		idemSeed: string
		cwd: string | null
		envVars: Record<string, string> | null
		timeoutSRaw: unknown
		allowDuplicate: boolean
		label: string | null
		idemWindowMs: number
	},
): Promise<Enqueued> {
	const stub = envStub(env, a.envId)
	const ready = await ensureReady(stub, a.envId)
	if (!ready.ok) return { ok: false, payload: ready.payload }
	const snap = ready.snap
	const warnings: string[] = [...((snap.warnings as string[]) || [])]

	let timeoutS = clamp(numArg(a.timeoutSRaw, 3600), 1, 21600)
	const ttlRemaining = Number(snap.ttl_remaining_s || 0)
	if (timeoutS > ttlRemaining - 30) {
		const clamped = Math.max(1, ttlRemaining - 30)
		warnings.push(
			`timeout_s clamped from ${timeoutS}s to ${clamped}s because the lease has ${ttlRemaining}s left; call env_extend if the job needs longer`,
		)
		timeoutS = clamped
	}

	const jobId = crypto.randomUUID().replace(/-/g, "").slice(0, 16)
	const idemHash = a.allowDuplicate ? `nodedupe:${jobId}` : await sha256Hex(a.idemSeed)

	const payload = {
		command_id: jobId,
		command: a.commandLine,
		shell: null,
		cwd: a.cwd,
		env: a.envVars,
		stdin_b64: null,
		timeout_s: timeoutS,
		inactivity_kill_s: 0,
		max_output_bytes: cfg.defaultMaxOutputBytes,
		keep_raw: false,
	}

	const enq = await stub.enqueue({
		command_id: jobId,
		idem_hash: idemHash,
		payload,
		label: a.label ? a.label.slice(0, 64) : null,
		cwd: a.cwd,
		shell: null,
		maxQueue: 8,
		idemWindowMs: a.idemWindowMs,
	})

	if (!enq.ok) {
		return {
			ok: false,
			payload: fail(
				"runner_busy_queue_full",
				`the runner already has ${enq.queue_depth} jobs queued (max ${enq.max_queue})`,
				{
					retry_after_ms: 2000,
					hint: "being busy is not an error; wait for one to finish or create a second environment",
					next_action: "poll_job on an earlier job_id",
				},
			),
		}
	}
	if (enq.deduped) {
		warnings.push(
			"an identical command was already in flight, so this returned that job instead of running it twice; pass allow_duplicate to force a second run",
		)
	}
	return { ok: true, jobId: enq.command_id, snap, enq, warnings }
}

function stringEnv(e: Record<string, string | number | boolean> | undefined) {
	// Stringified before hashing so {PORT: 8080} and {PORT: "8080"} dedupe
	// against each other instead of running the same command twice.
	return e ? Object.fromEntries(Object.entries(e).map(([k, v]) => [k, String(v)])) : null
}

export type Capture =
	| { ok: true; jobId: string; text: string; exitCode: number | null; warnings: string[] }
	| { ok: false; payload: Record<string, unknown> }

/**
 * Run one internal helper command and return its WHOLE output as text.
 *
 * This exists for get_image, which needs a few megabytes of base64 back from a
 * platform command, and it is deliberately not part of the tool surface: it
 * buffers everything in the Worker, which is exactly what the byte-window
 * protocol refuses to do for user commands.
 *
 * The bytes are decoded here rather than through renderText() on purpose. That
 * path strips ANSI and cuts at a line boundary, both of which would corrupt a
 * base64 blob, and its held-back tail cannot guarantee forward progress when a
 * window contains no newline at all. Nothing derived from these offsets is ever
 * handed to a caller, so this does not become a second cut site.
 */
export async function runCapture(
	env: Bindings,
	cfg: BrokerConfig,
	envId: string,
	commandLine: string,
	o: { label: string; timeoutS: number; deadlineMs: number; maxChars: number; note: string },
	ctx: { signal: AbortSignal; note: (m: string) => void },
): Promise<Capture> {
	const sub = await enqueueCommand(env, cfg, {
		envId,
		commandLine,
		idemSeed: "",
		cwd: null,
		envVars: null,
		timeoutSRaw: o.timeoutS,
		allowDuplicate: true,
		label: o.label,
		idemWindowMs: o.deadlineMs + 60_000,
	})
	if (!sub.ok) return { ok: false, payload: sub.payload }

	const stub = envStub(env, envId)
	const jobId = sub.jobId
	const dl = new Deadline(Math.min(o.deadlineMs, SOFT_CAP_MS), ctx.signal)
	const clock = makePollClock(WINDOW_POLL_MIN_MS, WINDOW_POLL_MAX_MS)

	let w: any = null
	for (;;) {
		const r = await tryCall(() => stub.window(jobId, 0, 1024))
		if (r.value) w = r.value
		if (w && isTerminal(w.state)) break
		ctx.note(o.note)
		if (!(await dl.tick(clock.next()))) {
			return {
				ok: false,
				payload: ok(
					{ job_id: jobId, env_id: envId, status: "running", state: w?.state ?? "queued" },
					{
						warnings: [...sub.warnings, "the helper command has not finished; it was queued, not abandoned"],
						hint: "raise deadline_ms, or read the raw output yourself with poll_job",
						next_action: `poll_job(env_id: "${envId}", job_id: "${jobId}", from_byte: 0, until: "exit")`,
					},
				),
			}
		}
	}

	if (w.state === "lost") {
		return {
			ok: false,
			payload: fail("lost", "the runner cannot account for the helper command", {
				extra: { job_id: jobId, env_id: envId, agent_error: w.agent_error ?? null },
				warnings: sub.warnings,
				next_action: `env_status(env_id: "${envId}", verbose: true)`,
			}),
		}
	}

	const decoder = new TextDecoder()
	let text = ""
	let from = 0
	const warnings = [...sub.warnings]

	for (;;) {
		const r = await tryCall(() => stub.window(jobId, from, MAX_WINDOW_BYTES))
		let win = r.value
		if (!win) {
			return {
				ok: false,
				payload: fail("broker_internal", "the broker could not read the helper command's output", {
					on_error: "retry",
					retry_after_ms: 1000,
					extra: { job_id: jobId, env_id: envId },
					warnings,
				}),
			}
		}

		// Anything past the ring's horizon is re-served by the runner over the
		// control channel it is already parked on.
		if (win.range_evicted) {
			ctx.note("re-serving an evicted range from the runner")
			const { req_id } = await stub.requestPull(jobId, from, MAX_WINDOW_BYTES)
			const pullDl = new Deadline(Math.min(15000, Math.max(2000, dl.remaining)), ctx.signal)
			const pullClock = makePollClock(150, 1_000)
			let got: any = null
			for (;;) {
				got = await stub.takePull(req_id)
				if (got) break
				if (!(await pullDl.tick(pullClock.next()))) break
			}
			if (!got) {
				return {
					ok: false,
					payload: fail("broker_unreachable", "the runner did not re-serve the output range in time", {
						retry_after_ms: 1000,
						extra: { job_id: jobId, env_id: envId, from_byte: from },
						warnings,
					}),
				}
			}
			win = { ...win, bytes_b64: got.bytes_b64, start_byte: got.start, range_evicted: false }
		}

		const raw = b64decode(String(win.bytes_b64 || ""))
		text += decoder.decode(raw)
		from = Number(win.start_byte ?? from) + raw.length

		if (text.length > o.maxChars) {
			return {
				ok: false,
				payload: fail("bad_input", `the helper command produced more than ${o.maxChars} characters`, {
					extra: { job_id: jobId, env_id: envId },
					warnings,
					hint: "this is too large to return in one tool result; shrink it on the runner first",
					next_action: "execute",
				}),
			}
		}
		if (win.eof) break
		if (raw.length === 0 && !(await dl.tick(250))) {
			warnings.push("the output stopped arriving before end of file; what follows may be incomplete")
			break
		}
	}

	return { ok: true, jobId, text, exitCode: w.exit_code ?? null, warnings }
}

export function buildRunTools(env: Bindings, cfg: BrokerConfig): ToolDef[] {
	const EXECUTE_DESCRIPTION =
		"Run a command in the environment and wait for it, but only for wait_ms (default 30s) -- after that you get a job_id and resume with poll_job, so a 40-minute build is normal rather than a timeout. " +
		"command is an argv array and there is NO shell in between: for pipes, redirection, globs or $VAR, run the shell yourself with [\"bash\", \"-lc\", \"...\"]. " +
		"The command runs UNCONFINED -- no filesystem or network sandbox -- because the environment is already a disposable VM that is destroyed with the job. " +
		"output is stdout and stderr interleaved into one stream, as the command wrote it, with ANSI escapes stripped and addressed by byte offset. " +
		"A non-zero exit_code is returned as data, not raised as an error. cwd persists between calls in the same environment. " +
		"For binary output, use get_file to return the original file, or get_image when the client should inspect an image."

	async function executeHandler(args: ExecuteArgs, ctx: { signal: AbortSignal; note: (m: string) => void }) {
		const envId = args.env_id
		const platform = platformOf(envId)

		const bad = checkArgv(args.command)
		if (bad) {
			return fail("bad_input", bad, {
				hint: 'command is an argv array, for example ["bash", "-lc", "npm test 2>&1 | tail -40"]',
				next_action: "execute",
			})
		}

		const waitMs = clamp(numArg(args.wait_ms, FOREGROUND_WAIT_MS), 1000, 45000)
		const maxBytes = clamp(numArg(args.max_bytes, 65536), 1024, MAX_WINDOW_BYTES)
		const envVars = stringEnv(args.env)

		const sub = await enqueueCommand(env, cfg, {
			envId,
			commandLine: renderArgv(platform, args.command),
			idemSeed: JSON.stringify([envId, args.command, args.cwd ?? null, envVars]),
			cwd: args.cwd ?? null,
			envVars,
			timeoutSRaw: args.timeout_s,
			allowDuplicate: Boolean(args.allow_duplicate),
			label: args.label ?? describeArgv(args.command),
			idemWindowMs: waitMs + 60_000,
		})
		if (!sub.ok) return sub.payload

		const stub = envStub(env, envId)
		const dl = new Deadline(Math.min(waitMs, SOFT_CAP_MS), ctx.signal)
		const clock = makePollClock(WINDOW_POLL_MIN_MS, WINDOW_POLL_MAX_MS)
		let w: any = null
		let pollError: PollError = null
		let because: ReturnedBecause = "deadline"

		for (;;) {
			const r = await tryCall(() => stub.window(sub.jobId, 0, maxBytes))
			if (r.value) {
				w = r.value
				pollError = null
			} else {
				pollError = r.pollError
			}
			if (w && isTerminal(w.state)) {
				because = "exit"
				break
			}
			if (w?.truncated) {
				because = "cap"
				break
			}
			ctx.note(w?.state === "queued" ? "queued behind another job" : "command running")
			if (!(await dl.tick(clock.next()))) {
				because = w?.state === "queued" ? "queued" : "deadline"
				break
			}
		}

		return jobResult({
			jobId: sub.jobId,
			envId,
			platform,
			w,
			returnedBecause: because,
			pollError,
			warnings: sub.warnings,
			deduped: sub.enq.deduped,
			queuePosition: sub.enq.queue_position,
			queueDepth: sub.enq.queue_depth,
			overlayVersion: sub.enq.overlay_version,
			runnerGone: Number(sub.snap.last_seen_ms_ago ?? 0) > 120_000,
			stickyCwd: (sub.snap.sticky_cwd as string) ?? null,
		})
	}

	const execute: ToolDef = {
		name: "execute",
		title: "Run a command",
		description: EXECUTE_DESCRIPTION,
		inputSchema: ExecuteInput,
		handler: executeHandler,
	}

	/*
	 * Identical to execute, by definition rather than by coincidence.
	 *
	 * It exists so a client written against local-mcp -- where without_sandbox is
	 * the escape hatch from Landlock/Seatbelt -- finds the tool it expects. There
	 * is nothing to escape from here, so the honest implementation is the same
	 * handler, and saying so in the description is better than quietly shipping a
	 * tool that implies the other one is confined.
	 */
	const withoutSandbox: ToolDef = {
		name: "without_sandbox",
		title: "Run a command (alias of execute)",
		description:
			"Alias of execute, kept for compatibility with clients that expect local-mcp's escape hatch. It behaves identically because there is no sandbox to leave: commands on a GitHub Actions runner are never confined in the first place. Prefer execute.",
		inputSchema: WithoutSandboxInput,
		handler: executeHandler,
	}

	const startCommand: ToolDef = {
		name: "start_command",
		title: "Start a command in the background",
		description:
			"Start a command and return a job_id immediately, without waiting for any output. Use this for servers, watchers and builds you intend to check on later; use execute when you want the result. " +
			"Same argv rules and the same unconfined execution as execute. Read it with poll_job, stop it with stop_job -- and note that nothing else will: the process keeps running until it exits, is stopped, or the environment's lease ends.",
		inputSchema: StartCommandInput,
		async handler(args: StartCommandArgs, ctx) {
			const envId = args.env_id
			const platform = platformOf(envId)

			const bad = checkArgv(args.command)
			if (bad) {
				return fail("bad_input", bad, {
					hint: 'command is an argv array, for example ["bash", "-lc", "npm run dev"]',
					next_action: "start_command",
				})
			}

			const envVars = stringEnv(args.env)
			const sub = await enqueueCommand(env, cfg, {
				envId,
				commandLine: renderArgv(platform, args.command),
				idemSeed: JSON.stringify([envId, args.command, args.cwd ?? null, envVars]),
				cwd: args.cwd ?? null,
				envVars,
				timeoutSRaw: args.timeout_s,
				allowDuplicate: Boolean(args.allow_duplicate),
				label: args.label ?? describeArgv(args.command),
				idemWindowMs: 60_000,
			})
			if (!sub.ok) return sub.payload

			// One cheap probe, so the answer carries a real state instead of a
			// placeholder -- but no waiting: returning at once is the entire point.
			const stub = envStub(env, envId)
			const r = await tryCall(() => stub.window(sub.jobId, 0, 1024))
			ctx.note("command started")

			return jobResult({
				jobId: sub.jobId,
				envId,
				platform,
				w: r.value,
				returnedBecause: r.value && isTerminal(r.value.state) ? "exit" : "queued",
				pollError: r.pollError,
				warnings: sub.warnings,
				deduped: sub.enq.deduped,
				queuePosition: sub.enq.queue_position,
				queueDepth: sub.enq.queue_depth,
				overlayVersion: sub.enq.overlay_version,
				runnerGone: Number(sub.snap.last_seen_ms_ago ?? 0) > 120_000,
				stickyCwd: (sub.snap.sticky_cwd as string) ?? null,
			})
		},
	}

	const pollJob: ToolDef = {
		name: "poll_job",
		title: "Read a job's output / wait for it to finish",
		description:
			"Resume a job's output from a byte offset, optionally waiting: until 'exit' waits up to wait_ms for the job to finish, until 'any_output' returns as soon as there is anything new. " +
			"Returns exactly the same fields as execute. Loop with from_byte = next_byte until eof is true. " +
			"Re-reading an offset you have already read is always safe and always returns the same bytes, which is what makes this recoverable after a client-side timeout.",
		inputSchema: PollJobInput,
		readOnly: true,
		async handler(args: PollJobArgs, ctx) {
			const envId = args.env_id
			const jobId = args.job_id
			const platform = platformOf(envId)
			const stub = envStub(env, envId)

			const snap = await stub.snapshot(false)
			if (!snap.env_id) return fail("env_not_found", `no environment ${envId}`, { next_action: "env_list" })

			const fromByte = Math.max(0, numArg(args.from_byte, 0))
			const maxBytes = clamp(numArg(args.max_bytes, 65536), 1024, MAX_WINDOW_BYTES)
			const waitMs = clamp(numArg(args.wait_ms, 20000), 0, 45000)
			const until = args.until === "exit" ? "exit" : "any_output"
			const warnings: string[] = [...((snap.warnings as string[]) || [])]

			const dl = new Deadline(Math.min(waitMs, SOFT_CAP_MS), ctx.signal)
			const clock = makePollClock(WINDOW_POLL_MIN_MS, WINDOW_POLL_MAX_MS)
			let w: any = null
			let pollError: PollError = null
			let because: ReturnedBecause = "deadline"
			let pulled = false

			for (;;) {
				const r = await tryCall(() => stub.window(jobId, fromByte, maxBytes))
				if (r.value) {
					w = r.value
					pollError = null
				} else {
					pollError = r.pollError
				}
				if (w && !w.found) {
					return fail("bad_input", `no job ${jobId} in ${envId}`, {
						next_action: `env_status(env_id: "${envId}", verbose: true)`,
					})
				}

				// The broker cannot reach the runner inbound, so an evicted range is
				// fetched by queuing a pull on the control channel the runner is
				// already parked on -- it arrives in milliseconds.
				if (w?.range_evicted && !pulled) {
					pulled = true
					ctx.note("re-serving an evicted range from the runner")
					const { req_id } = await stub.requestPull(jobId, fromByte, maxBytes)
					const pullDl = new Deadline(Math.min(15000, Math.max(2000, dl.remaining)), ctx.signal)
					const pullClock = makePollClock(150, 1_000)
					for (;;) {
						const got = await stub.takePull(req_id)
						if (got) {
							// Only the payload and its offset are replaced. next_byte is
							// not computed here: jobResult derives it from the bytes the
							// cut actually consumed, which is the one cut site.
							w = { ...w, bytes_b64: got.bytes_b64, start_byte: got.start, range_evicted: false }
							warnings.push("this range was re-served from the runner's own output file")
							break
						}
						if (!(await pullDl.tick(pullClock.next()))) {
							warnings.push("the runner did not answer the range request in time; call poll_job again")
							pollError = { code: "broker_unreachable", message: "range pull timed out", retryable: true }
							break
						}
					}
				}

				const terminal = Boolean(w && isTerminal(w.state))
				const haveBytes = Boolean(w?.bytes_b64)
				if (terminal && (until === "exit" || haveBytes || w.eof)) {
					because = "exit"
					break
				}
				if (until === "any_output" && haveBytes) {
					because = w?.truncated ? "cap" : "idle"
					break
				}
				ctx.note(until === "exit" ? "waiting for the job to exit" : "waiting for output")
				if (!(await dl.tick(clock.next()))) {
					because = w?.state === "queued" ? "queued" : "deadline"
					break
				}
			}

			if (until === "exit" && because === "deadline") {
				// Honest about the one thing this contract cannot distinguish.
				warnings.push(
					"waited for exit and it has not happened yet. A healthy long build and a stuck command look identical from here -- check idle_seconds and the tail of the output before assuming progress.",
				)
			}

			return jobResult({
				jobId,
				envId,
				platform,
				w,
				returnedBecause: because,
				pollError,
				warnings,
				deduped: false,
				queuePosition: 0,
				queueDepth: Number(snap.queue_depth || 0),
				overlayVersion: Number(snap.overlay_version || 0),
				runnerGone: Number(snap.last_seen_ms_ago ?? 0) > 120_000,
				stickyCwd: (snap.sticky_cwd as string) ?? null,
			})
		},
	}

	const stopJob: ToolDef = {
		name: "stop_job",
		title: "Stop a job",
		description:
			"Stop one job_id, or 'all'. Kills the whole process tree, so a build that spawned children does not leave orphans behind holding the output file open. The output written so far stays readable with poll_job.",
		inputSchema: StopJobInput,
		async handler(args: StopJobArgs, ctx) {
			const envId = args.env_id
			const jobId = args.job_id
			const signal = args.signal ?? "TERM"

			const stub = envStub(env, envId)
			const { killed } = await stub.killCommand(jobId, signal)

			// The kill rides the control long-poll, which is parked, so confirmation
			// normally arrives within a second or two.
			const dl = new Deadline(12000, ctx.signal)
			const clock = makePollClock(300, WINDOW_POLL_MAX_MS)
			let state: string | null = null
			let exitCode: number | null = null
			if (jobId !== "all") {
				for (;;) {
					const r = await tryCall(() => stub.window(jobId, 0, 1024))
					state = r.value?.state ?? state
					exitCode = r.value?.exit_code ?? exitCode
					if (state && isTerminal(state)) break
					ctx.note("waiting for the job to report termination")
					if (!(await dl.tick(clock.next()))) break
				}
			}

			// 'all' is accepted here but it is not a job_id, so echoing it back as a
			// poll_job suggestion sends the caller to a job that cannot be found.
			// Name one that was actually killed instead.
			const readId: string | null = jobId === "all" ? (killed?.[0] ?? null) : jobId

			return ok(
				{
					status: "stopped",
					job_id: jobId,
					env_id: envId,
					killed,
					state: state ?? "killed",
					exit_code: exitCode,
					tree_killed: true,
					signal,
				},
				{
					warnings:
						state && !isTerminal(state) && jobId !== "all"
							? ["the kill was delivered but the job has not reported termination yet; check with poll_job"]
							: [],
					next_action: readId
						? `poll_job(env_id: "${envId}", job_id: "${readId}", from_byte: 0)`
						: `env_status(env_id: "${envId}", verbose: true)`,
				},
			)
		},
	}

	return [execute, startCommand, pollJob, stopJob, withoutSandbox]
}
