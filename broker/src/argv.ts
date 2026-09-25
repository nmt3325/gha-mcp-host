/*
 * argv -> one command line, and nothing else.
 *
 * The tools take a command as an argv array, the way local-mcp does:
 * ["git", "commit", "-m", "a message"]. The runner executes a script file with
 * a shell, because that is what produces the cwd / rc / overlay epilogue and
 * the single merged output file the byte protocol is built on. So argv has to
 * be rendered back into one line, and the rendering has to be lossless: every
 * element is quoted, so the shell cannot split, glob or expand any part of it.
 *
 * This is NOT a sandbox and must not be read as one. Quoting decides where an
 * argument ends; it does not decide what the command may do. The isolation
 * boundary here is the ephemeral GitHub Actions runner itself -- a throwaway VM
 * that is destroyed with the job -- so commands run with that runner's full
 * rights, deliberately, and there is no filesystem or network confinement to
 * port from local-mcp's Landlock/Seatbelt path.
 */

import type { Platform } from "./config"

/** Longer than any real argv. Past this it is a bug, not a command. */
export const ARGV_MAX_ITEMS = 512
export const ARGV_MAX_CHARS = 131_072

/** POSIX single-quote: close, escape, reopen. Mirrors lib/shell.mjs `q`. */
export function posixQuote(s: string): string {
	return "'" + s.split("'").join("'\\''") + "'"
}

/** PowerShell single-quote: double it. Mirrors lib/shell.mjs `pq`. */
export function pwshQuote(s: string): string {
	return "'" + s.split("'").join("''") + "'"
}

/**
 * Render argv for the shell that platform's runner defaults to: bash on Linux
 * and macOS, pwsh on Windows.
 *
 * The pwsh form needs the call operator. Without it a quoted first element is
 * a string literal, and PowerShell politely echoes the program name instead of
 * running it -- which looks like a command that succeeded and printed one line.
 */
export function renderArgv(platform: Platform, argv: readonly string[]): string {
	if (platform === "windows") return "& " + argv.map(pwshQuote).join(" ")
	return argv.map(posixQuote).join(" ")
}

/** Short human-readable form, for labels and progress notes. Never executed. */
export function describeArgv(argv: readonly string[]): string {
	const text = argv.join(" ")
	return text.length > 64 ? text.slice(0, 61) + "..." : text
}

/**
 * @returns an error message, or null when this argv can be rendered.
 *
 * A newline inside an argument is fine -- quoting keeps it inside the argument.
 * A NUL is not: it cannot survive being written into a script file, and the
 * shell would silently truncate the argument there.
 */
export function checkArgv(argv: readonly string[]): string | null {
	if (argv.length === 0) return "command must be a non-empty array of strings"
	if (argv.length > ARGV_MAX_ITEMS) {
		return `command has ${argv.length} elements; the maximum is ${ARGV_MAX_ITEMS}`
	}
	if (!argv[0].trim()) return "the first element of command must be the program to run"
	let chars = 0
	for (const a of argv) {
		if (a.includes("\u0000")) return "command elements must not contain NUL bytes"
		chars += a.length
	}
	if (chars > ARGV_MAX_CHARS) {
		return `command is ${chars} characters long; the maximum is ${ARGV_MAX_CHARS}`
	}
	return null
}
