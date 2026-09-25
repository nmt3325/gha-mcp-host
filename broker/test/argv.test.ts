/*
 * argv rendering.
 *
 * The assertions that matter are not the shapes of the quoted strings but the
 * round trip: the runner executes a shell script, so the only question worth
 * answering is whether the shell hands the program back exactly the arguments
 * that went in. Everything dangerous about argv -- spaces, quotes, $VAR, |, *,
 * newlines -- is tested by running it.
 */

import { execFileSync } from "node:child_process"
import { describe, expect, test } from "vitest"

import { checkArgv, describeArgv, posixQuote, pwshQuote, renderArgv } from "../src/argv"

const POSIX = process.platform !== "win32"

/** Ask bash what the arguments were, one per line, NUL-free by construction. */
function bashArgs(argv: string[]): string[] {
	const line = renderArgv("linux", argv)
	const out = execFileSync("bash", ["--noprofile", "--norc", "-c", `printf '%s\\0' ${line}`], {
		encoding: "utf8",
	})
	const parts = out.split("\0")
	parts.pop()
	return parts
}

describe("posixQuote", () => {
	test("wraps in single quotes", () => {
		expect(posixQuote("hello")).toBe("'hello'")
	})

	test("escapes a single quote by closing, escaping and reopening", () => {
		expect(posixQuote("it's")).toBe("'it'\\''s'")
	})

	test("leaves everything else alone, because the quotes do the work", () => {
		expect(posixQuote('$HOME | rm -rf * `x` "y"')).toBe('\'$HOME | rm -rf * `x` "y"\'')
	})
})

describe("pwshQuote", () => {
	test("doubles a single quote", () => {
		expect(pwshQuote("it's")).toBe("'it''s'")
	})

	test("does not treat a backtick as an escape, unlike double quotes", () => {
		expect(pwshQuote("a`b")).toBe("'a`b'")
	})
})

describe("renderArgv", () => {
	test("posix joins quoted words", () => {
		expect(renderArgv("linux", ["git", "commit", "-m", "a message"])).toBe(
			"'git' 'commit' '-m' 'a message'",
		)
	})

	test("windows needs the call operator, or pwsh echoes the program name", () => {
		expect(renderArgv("windows", ["git", "status"])).toBe("& 'git' 'status'")
	})

	test("macos renders like linux", () => {
		expect(renderArgv("macos", ["ls", "-la"])).toBe(renderArgv("linux", ["ls", "-la"]))
	})
})

describe.skipIf(!POSIX)("a real shell gets exactly the arguments we passed", () => {
	const cases: Array<[string, string[]]> = [
		["plain", ["a", "b", "c"]],
		["spaces", ["a b", " leading", "trailing "]],
		["single quotes", ["it's", "'", "''"]],
		["double quotes and backticks", ['say "hi"', "`whoami`"]],
		["shell metacharacters stay literal", ["a|b", "a>b", "a&&b", "a;b", "a#b"]],
		["globs are not expanded", ["*", "?", "[a-z]", "~"]],
		["variables are not expanded", ["$HOME", "${PATH}", "$(id -u)"]],
		["newlines and tabs survive", ["line1\nline2", "a\tb"]],
		["unicode survives", ["日本語", "emoji \u{1F600}"]],
		["an empty argument is still an argument", ["a", "", "b"]],
	]

	for (const [name, argv] of cases) {
		test(name, () => {
			expect(bashArgs(argv)).toEqual(argv)
		})
	}

	test("the command is not re-split on whitespace inside one element", () => {
		expect(bashArgs(["echo hello"])).toEqual(["echo hello"])
	})
})

describe("checkArgv", () => {
	test("accepts a normal argv", () => {
		expect(checkArgv(["bash", "-lc", "make"])).toBeNull()
	})

	test("refuses an empty argv", () => {
		expect(checkArgv([])).toMatch(/non-empty/)
	})

	test("refuses a blank program name, which would run the shell's null command", () => {
		expect(checkArgv(["   "])).toMatch(/first element/)
	})

	test("refuses a NUL, which the script file cannot carry", () => {
		expect(checkArgv(["printf", "a\u0000b"])).toMatch(/NUL/)
	})

	test("refuses an argv longer than the item limit", () => {
		expect(checkArgv(new Array(513).fill("x"))).toMatch(/maximum/)
	})

	test("refuses one enormous argument", () => {
		expect(checkArgv(["echo", "x".repeat(131_073)])).toMatch(/characters/)
	})

	test("a newline inside an argument is allowed; quoting keeps it inside", () => {
		expect(checkArgv(["printf", "%s", "a\nb"])).toBeNull()
	})
})

describe("describeArgv", () => {
	test("joins with spaces for a label", () => {
		expect(describeArgv(["npm", "run", "build"])).toBe("npm run build")
	})

	test("truncates so it fits a label field", () => {
		const long = describeArgv(["echo", "y".repeat(200)])
		expect(long.length).toBeLessThanOrEqual(64)
		expect(long.endsWith("...")).toBe(true)
	})
})
