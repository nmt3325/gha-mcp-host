/*
 * A unified diff, good enough to show what a write actually changed.
 *
 * local-mcp answers a write with `Edited <path> (+3 -1)` and a diff at context
 * radius 3, and that summary is most of the tool's value: it is how the caller
 * finds out the write did something other than what it intended. We compute it
 * in the broker from the copy of the file read immediately before the write,
 * so the runner keeps exactly one write path and gains nothing to get wrong.
 *
 * It is a line diff over an LCS, not Myers with its heuristics. The common head
 * and tail are trimmed first, which is what makes a one-line change to a large
 * file cheap; only the disagreeing middle reaches the quadratic part, and past
 * DIFF_MAX_CELLS we report counts and skip the hunks rather than allocate.
 */

export const CONTEXT_RADIUS = 3
/** The DP table is 4 bytes per cell; 1M cells is 4 MB and ~1000x1000 lines. */
export const DIFF_MAX_CELLS = 1_000_000
/** A diff longer than this is not being read by anyone. */
export const DIFF_MAX_CHARS = 20_000

export type DiffResult = {
	added: number
	removed: number
	/** Unified diff text, or null when there was nothing or too much to show. */
	diff: string | null
	identical: boolean
	/** True when the hunks were skipped or cut; the counts still hold. */
	truncated: boolean
}

type Op = { tag: " " | "-" | "+"; line: string }

/**
 * A trailing newline terminates the last line, it does not start a new one.
 * Treating it as a line makes every append look like it also rewrote the line
 * before it.
 */
function splitLines(text: string): string[] {
	if (text === "") return []
	const lines = text.split("\n")
	if (lines[lines.length - 1] === "") lines.pop()
	return lines
}

function lcsOps(a: string[], b: string[]): Op[] | null {
	if (a.length * b.length > DIFF_MAX_CELLS) return null
	const n = a.length
	const m = b.length
	const dp: Uint32Array[] = []
	for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1))
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
		}
	}
	const ops: Op[] = []
	let i = 0
	let j = 0
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			ops.push({ tag: " ", line: a[i] })
			i++
			j++
		} else if (dp[i + 1][j] >= dp[i][j + 1]) {
			ops.push({ tag: "-", line: a[i] })
			i++
		} else {
			ops.push({ tag: "+", line: b[j] })
			j++
		}
	}
	while (i < n) ops.push({ tag: "-", line: a[i++] })
	while (j < m) ops.push({ tag: "+", line: b[j++] })
	return ops
}

function renderHunks(ops: Op[]): string {
	const oldNo = new Array<number>(ops.length)
	const newNo = new Array<number>(ops.length)
	let o = 0
	let n = 0
	for (let i = 0; i < ops.length; i++) {
		if (ops[i].tag !== "+") o++
		if (ops[i].tag !== "-") n++
		oldNo[i] = o
		newNo[i] = n
	}

	const ranges: Array<[number, number]> = []
	for (let i = 0; i < ops.length; i++) {
		if (ops[i].tag === " ") continue
		const start = Math.max(0, i - CONTEXT_RADIUS)
		const end = Math.min(ops.length - 1, i + CONTEXT_RADIUS)
		const last = ranges[ranges.length - 1]
		// Touching or overlapping windows become one hunk, the way diff does it:
		// two @@ headers one line apart are noise, not information.
		if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end)
		else ranges.push([start, end])
	}

	const out: string[] = []
	for (const [s, e] of ranges) {
		let oldStart = 0
		let newStart = 0
		let oldLen = 0
		let newLen = 0
		for (let i = s; i <= e; i++) {
			if (ops[i].tag !== "+") {
				if (oldLen === 0) oldStart = oldNo[i]
				oldLen++
			}
			if (ops[i].tag !== "-") {
				if (newLen === 0) newStart = newNo[i]
				newLen++
			}
		}
		out.push(`@@ -${oldLen === 0 ? 0 : oldStart},${oldLen} +${newLen === 0 ? 0 : newStart},${newLen} @@`)
		for (let i = s; i <= e; i++) out.push(ops[i].tag + ops[i].line)
	}
	return out.join("\n")
}

export function unifiedDiff(oldText: string, newText: string): DiffResult {
	if (oldText === newText) return { added: 0, removed: 0, diff: null, identical: true, truncated: false }

	const a = splitLines(oldText)
	const b = splitLines(newText)

	let head = 0
	while (head < a.length && head < b.length && a[head] === b[head]) head++
	let tail = 0
	while (
		tail < a.length - head &&
		tail < b.length - head &&
		a[a.length - 1 - tail] === b[b.length - 1 - tail]
	) {
		tail++
	}

	const midA = a.slice(head, a.length - tail)
	const midB = b.slice(head, b.length - tail)
	const ops = lcsOps(midA, midB)
	if (!ops) {
		return { added: midB.length, removed: midA.length, diff: null, identical: false, truncated: true }
	}

	let added = 0
	let removed = 0
	for (const op of ops) {
		if (op.tag === "+") added++
		else if (op.tag === "-") removed++
	}

	const full: Op[] = []
	for (let i = 0; i < head; i++) full.push({ tag: " ", line: a[i] })
	for (const op of ops) full.push(op)
	for (let i = a.length - tail; i < a.length; i++) full.push({ tag: " ", line: a[i] })

	let text = renderHunks(full)
	let truncated = false
	if (text.length > DIFF_MAX_CHARS) {
		text = text.slice(0, DIFF_MAX_CHARS) + "\n... diff truncated"
		truncated = true
	}

	// Same bytes, different line endings only: the counts are honest, the diff
	// would be a wall of identical-looking lines.
	return { added, removed, diff: text === "" ? null : text, identical: false, truncated }
}
