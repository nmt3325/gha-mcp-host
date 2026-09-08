/* A bounded human-readable preview, never an executable patch. */
export function boundedDiff(before, after, pathname) {
  const old = before.split("\n"), next = after.split("\n")
  let first = 0
  while (first < old.length && first < next.length && old[first] === next[first]) first++
  let suffix = 0
  while (suffix < old.length - first && suffix < next.length - first && old[old.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++
  const begin = Math.max(0, first - 3)
  const oldEnd = Math.min(old.length, old.length - suffix + 3)
  const newEnd = Math.min(next.length, next.length - suffix + 3)
  const output = [`--- ${pathname}`, `+++ ${pathname}`, `@@ -${begin + 1},${oldEnd - begin} +${begin + 1},${newEnd - begin} @@`]
  let bytes = output.join("\n").length, truncated = false
  function add(prefix, line) {
    const s = prefix + line
    const n = Buffer.byteLength(s) + 1
    if (output.length >= 120 || bytes + n > 12000) { truncated = true; return false }
    output.push(s); bytes += n; return true
  }
  for (let i = begin; i < first; i++) if (!add(" ", old[i])) break
  for (let i = first; i < old.length - suffix; i++) if (!add("-", old[i])) break
  for (let i = first; i < next.length - suffix; i++) if (!add("+", next[i])) break
  for (let i = next.length - suffix; i < newEnd; i++) if (!add(" ", next[i])) break
  return { diff: output.join("\n"), diff_truncated: truncated, diff_format: "preview_not_applyable", changed_at_line: first + 1 }
}
