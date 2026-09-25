import { z } from "zod"
import type { BrokerConfig, Platform } from "./config"

/*
 * Tool input schemas.
 *
 * The MCP server validates arguments against these before the handler runs,
 * and returns an isError result the model can read when they do not match.
 * Handlers therefore receive well-typed values and do no shape checking.
 *
 * What is intentionally NOT here: numeric ranges. Every numeric field is
 * clamped by the handler, so encoding the range here would (a) reject values
 * the broker is perfectly happy to clamp and (b) put one limit in two places.
 * The clamp is still DOCUMENTED in every describe(), because a caller who
 * cannot see the floor cannot understand why max_bytes: 400 returned 999.
 */

export const ENV_ID_RE = /^(linux|mac|win)-[0-9a-hjkmnp-tv-z]{8}$/

const ENV_ID_HELP =
	"Environment id returned by env_create, shaped like linux-a1b2c3d4, mac-a1b2c3d4 or win-a1b2c3d4. Call env_list if you do not have one."

export const EnvIdField = z.string().regex(ENV_ID_RE, ENV_ID_HELP).describe(ENV_ID_HELP)

export const PlatformSchema = z.enum(["linux", "macos", "windows"])

/** Fails typecheck if config gains a platform this enum does not list. */
type PlatformsCovered = Exclude<Platform, z.infer<typeof PlatformSchema>> extends never ? true : never
const platformsCovered: PlatformsCovered = true
void platformsCovered

/* ------------------------------------------------------------------- env_* */

export function envCreateInput(cfg: BrokerConfig) {
	return z.strictObject({
		platform: PlatformSchema.describe("linux | macos | windows"),
		ttl_minutes: z
			.number()
			.optional()
			.describe(
				`Lease length in minutes. Default ${cfg.defaultTtlMinutes}, clamped to ${cfg.maxTtlMinutes} because GitHub kills any job at 6 hours.`,
			),
		label: z.string().optional().describe("Short human label, shown in env_list."),
		wait: z
			.boolean()
			.optional()
			.describe(
				"Wait for the runner to enroll before returning. Still returns within ~45s whether or not it became ready.",
			),
	})
}

export function envExtendInput(cfg: BrokerConfig) {
	return z.strictObject({
		env_id: EnvIdField,
		minutes: z
			.number()
			.describe(
				`Minutes to ADD to the lease it has now. This never shortens a lease, and it is clamped so the lease stays within ${cfg.maxTtlMinutes} minutes of when the environment was created.`,
			),
	})
}

export const EnvStatusInput = z.strictObject({
	env_id: EnvIdField,
	verbose: z
		.boolean()
		.optional()
		.describe("Include runner facts: node version, cpu count, memory, available shells, base64 recipes."),
	wait_ready_ms: z
		.number()
		.optional()
		.describe("Block until the state leaves 'provisioning'. Clamped to 45000. Use this right after env_create."),
})

export const EnvListInput = z.strictObject({})

export const EnvDestroyInput = z.strictObject({
	env_id: EnvIdField,
	force: z.boolean().optional().describe("Destroy even if another session created it."),
})

/* ---------------------------------------------------------------- commands */

const EnvValue = z.union([z.string(), z.number(), z.boolean()])

const COMMAND_HELP =
	'The command as an argv array: ["git", "commit", "-m", "a message"]. Element 0 is the program, the rest are its arguments, and every element is passed through verbatim. There is no shell in between, so |, >, &&, *, ~ and $VAR are ordinary characters here -- when you want them interpreted, run the shell yourself: ["bash", "-lc", "make 2>&1 | tail -40"].'

const CommandField = z.array(z.string()).min(1).describe(COMMAND_HELP)

const CwdField = z
	.string()
	.optional()
	.describe(
		"Working directory for this command only. Relative paths resolve against the environment's sticky cwd, which persists between calls.",
	)

const EnvField = z
	.record(z.string(), EnvValue)
	.optional()
	.describe("Extra environment variables for this command. Non-string values are stringified.")

const TimeoutField = z
	.number()
	.optional()
	.describe("Kill the command after this many seconds. Default 3600, and further clamped to the remaining lease.")

const AllowDuplicateField = z
	.boolean()
	.optional()
	.describe(
		"Run it even if an identical command is already in flight. Without this, a repeat of the same argv within the dedupe window returns the first job instead of starting a second one, which is what makes a retry after a client timeout safe.",
	)

const LabelField = z.string().optional().describe("Short human label for env_status listings.")

const JobIdField = z.string().min(1).describe("job_id returned by execute or start_command.")

export const ExecuteInput = z.strictObject({
	env_id: EnvIdField,
	command: CommandField,
	cwd: CwdField,
	env: EnvField,
	timeout_s: TimeoutField,
	wait_ms: z
		.number()
		.optional()
		.describe(
			"How long to wait for the command to finish before handing back a job_id instead. Default 30000, max 45000: past that the MCP client itself times out and the job_id is lost.",
		),
	max_bytes: z
		.number()
		.optional()
		.describe("Output bytes to return. Default 65536, max 262144, minimum 1024."),
	allow_duplicate: AllowDuplicateField,
	label: LabelField,
})

/** without_sandbox is an alias of execute; see tools-run.ts for why. */
export const WithoutSandboxInput = ExecuteInput

export const StartCommandInput = z.strictObject({
	env_id: EnvIdField,
	command: CommandField,
	cwd: CwdField,
	env: EnvField,
	timeout_s: TimeoutField,
	allow_duplicate: AllowDuplicateField,
	label: LabelField,
})

export const PollJobInput = z.strictObject({
	env_id: EnvIdField,
	job_id: JobIdField,
	from_byte: z
		.number()
		.optional()
		.describe(
			"Byte offset to resume the output from. Pass next_byte from the previous call. Re-reading an offset you already read is always safe and returns the same bytes.",
		),
	max_bytes: z.number().optional().describe("Default 65536, max 262144, minimum 1024."),
	wait_ms: z
		.number()
		.optional()
		.describe("How long to wait for something to happen before answering anyway. Default 20000, max 45000."),
	until: z
		.enum(["any_output", "exit"])
		.optional()
		.describe(
			"'any_output' returns as soon as there is anything new; 'exit' waits for the job to finish. Default any_output.",
		),
})

export const StopJobInput = z.strictObject({
	env_id: EnvIdField,
	job_id: z
		.string()
		.min(1)
		.describe(
			"A job_id, or the literal string 'all'. 'all' is accepted only here -- it is not a job_id you can later poll.",
		),
	signal: z.enum(["TERM", "KILL"]).optional().describe("Default TERM, which escalates to KILL after 3s."),
})

/* ------------------------------------------------------------------- files */

const PathField = z.string().min(1).max(4096).describe("Absolute path, or relative to the sticky cwd.")

export const ReadFileInput = z.strictObject({
	env_id: EnvIdField,
	path: PathField,
	offset: z.number().optional().describe("First line to return, 0-based. A negative offset reads the tail."),
	limit: z.number().optional().describe("How many lines to return. Default 2000."),
	from_byte: z.number().optional().describe("Resume from this byte offset instead of the start."),
	max_bytes: z.number().optional().describe("Bytes to transfer. Default 65536, max 131072."),
	deadline_ms: z.number().optional().describe("How long to wait for the runner. Default 20000, max 45000."),
})

export const WriteFileInput = z.strictObject({
	env_id: EnvIdField,
	path: PathField,
	content: z
		.string()
		.describe("The complete new contents of the file, as text. This replaces the file; it does not append."),
	base_sha: z
		.string()
		.optional()
		.describe(
			"sha256 of the file you based this write on, from read_file. The write is refused if the file changed since. Usually unnecessary: write_file reads the file itself immediately beforehand and uses that.",
		),
	create_parents: z.boolean().optional().describe("Create missing parent directories. Default false."),
	deadline_ms: z.number().optional().describe("How long to wait for the runner. Default 20000, max 45000."),
})

export const ListDirectoryInput = z.strictObject({
	env_id: EnvIdField,
	path: PathField,
	deadline_ms: z.number().optional().describe("How long to wait for the runner. Default 20000, max 45000."),
})

export const GetImageInput = z.strictObject({
	env_id: EnvIdField,
	path: PathField,
	deadline_ms: z.number().optional().describe("How long to wait for the runner. Default 30000, max 45000."),
})

export const GetFileInput = z.strictObject({
	env_id: EnvIdField,
	path: PathField,
	file_name: z
		.string()
		.min(1)
		.max(255)
		.regex(/^[^/\\]+$/)
		.optional()
		.describe("Download filename. Defaults to the basename of path; directory separators are not allowed."),
	mime_type: z
		.string()
		.min(1)
		.max(255)
		.optional()
		.describe("MIME type override. Defaults to magic-byte and extension detection."),
	deadline_ms: z.number().optional().describe("How long to wait for the runner. Default 30000, max 45000."),
})

export type EnvCreateArgs = z.infer<ReturnType<typeof envCreateInput>>
export type EnvExtendArgs = z.infer<ReturnType<typeof envExtendInput>>
export type EnvStatusArgs = z.infer<typeof EnvStatusInput>
export type EnvDestroyArgs = z.infer<typeof EnvDestroyInput>
export type ExecuteArgs = z.infer<typeof ExecuteInput>
export type StartCommandArgs = z.infer<typeof StartCommandInput>
export type PollJobArgs = z.infer<typeof PollJobInput>
export type StopJobArgs = z.infer<typeof StopJobInput>
export type ReadFileArgs = z.infer<typeof ReadFileInput>
export type WriteFileArgs = z.infer<typeof WriteFileInput>
export type ListDirectoryArgs = z.infer<typeof ListDirectoryInput>
export type GetImageArgs = z.infer<typeof GetImageInput>
export type GetFileArgs = z.infer<typeof GetFileInput>
