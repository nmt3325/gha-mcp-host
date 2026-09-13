/*
 * The diff write_file reports.
 *
 * What is being protected here is the counts and the fact that the hunks point
 * at the right lines: that summary is the only evidence the caller gets that a
 * write did what it meant to do, so a diff that is merely plausible is worse
 * than none.
 */

import { describe, expect, test } from "vitest"

import { CONTEXT_RADIUS, DIFF_MAX_CHARS, unifiedDiff } from "../src/diff"

const lines = (n: number, prefix = "line") =>
	Array.from({ length: n }, (_, i) => `${prefix}${i}`).join("\n") + "\n"

describe("unifiedDiff", () => {
	test("identical text is identical, with nothing to show", () => {
		const r = unifiedDiff("a\nb\n", "a\nb\n")
		expect(r).toEqual({ added: 0, removed: 0, diff: null, identical: true, truncated: false })
	})

	test("a changed line is one added and one removed", () => {
		const r = unifiedDiff("a\nb\nc\n", "a\nB\nc\n")
		expect(r.added).toBe(1)
		expect(r.removed).toBe(1)
		expect(r.diff).toContain("-b")
		expect(r.diff).toContain("+B")
		expect(r.diff).toContain("@@ -1,3 +1,3 @@")
	})

	test("an appended line is added only", () => {
		const r = unifiedDiff("a\n", "a\nb\n")
		expect(r.added).toBe(1)
		expect(r.removed).toBe(0)
		expect(r.diff).toContain("+b")
	})

	test("a deleted line is removed only", () => {
		const r = unifiedDiff("a\nb\n", "a\n")
		expect(r.added).toBe(0)
		expect(r.removed).toBe(1)
	})

	test("a trailing newline terminates the last line, it does not add one", () => {
		// Without this, every append would also claim to have rewritten the line
		// before it.
		const r = unifiedDiff("a\nb\n", "a\nb\nc\n")
		expect(r).toMatchObject({ added: 1, removed: 0 })
	})

	test("writing into an empty file counts every line as added", () => {
		const r = unifiedDiff("", "a\nb\nc\n")
		expect(r).toMatchObject({ added: 3, removed: 0, identical: false })
	})

	test("emptying a file counts every line as removed", () => {
		const r = unifiedDiff("a\nb\n", "")
		expect(r).toMatchObject({ added: 0, removed: 2 })
	})

	test("missing final newline is not a change of the line itself", () => {
		const r = unifiedDiff("a\nb", "a\nb\n")
		// The bytes differ, but no line was added or removed.
		expect(r.identical).toBe(false)
		expect(r.added).toBe(0)
		expect(r.removed).toBe(0)
	})

	test("one change in a large file stays cheap and local", () => {
		const before = lines(5000)
		const after = before.replace("line2500\n", "CHANGED\n")
		const started = Date.now()
		const r = unifiedDiff(before, after)
		expect(Date.now() - started).toBeLessThan(2000)
		expect(r).toMatchObject({ added: 1, removed: 1, truncated: false })
		// Only the neighbourhood of the change is laid out: two hunks' worth of
		// context at most, never 5000 lines of it.
		const body = (r.diff ?? "").split("\n")
		expect(body.length).toBeLessThanOrEqual(2 * CONTEXT_RADIUS + 4)
		expect(r.diff).toContain("+CHANGED")
		expect(r.diff).toContain("@@ -2498,7 +2498,7 @@")
	})

	test("two distant changes produce two hunks", () => {
		const before = lines(100)
		const after = before.replace("line5\n", "A\n").replace("line80\n", "B\n")
		const r = unifiedDiff(before, after)
		expect(r).toMatchObject({ added: 2, removed: 2 })
		const headers = (r.diff ?? "").split("\n").filter((l) => l.startsWith("@@"))
		expect(headers.length).toBe(2)
	})

	test("adjacent changes are merged into one hunk", () => {
		const before = lines(20)
		const after = before.replace("line5\n", "A\n").replace("line6\n", "B\n")
		const r = unifiedDiff(before, after)
		const headers = (r.diff ?? "").split("\n").filter((l) => l.startsWith("@@"))
		expect(headers.length).toBe(1)
	})

	test("a rewrite too big to lay out still reports honest counts", () => {
		const r = unifiedDiff(lines(4000, "old"), lines(4000, "new"))
		expect(r.added).toBe(4000)
		expect(r.removed).toBe(4000)
		expect(r.truncated).toBe(true)
		expect(r.diff).toBeNull()
	})

	test("a very long diff is cut, and says so", () => {
		const before = Array.from({ length: 400 }, (_, i) => `${i}:${"x".repeat(100)}`).join("\n")
		const after = Array.from({ length: 400 }, (_, i) => `${i}:${"y".repeat(100)}`).join("\n")
		const r = unifiedDiff(before, after)
		expect(r.truncated).toBe(true)
		expect((r.diff ?? "").length).toBeLessThanOrEqual(DIFF_MAX_CHARS + 32)
		expect(r.diff).toContain("diff truncated")
	})

	test("CRLF is a change of the line, not of nothing", () => {
		const r = unifiedDiff("a\nb\n", "a\r\nb\r\n")
		expect(r.identical).toBe(false)
		expect(r.added).toBe(2)
		expect(r.removed).toBe(2)
	})
})
