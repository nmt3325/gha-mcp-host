#!/usr/bin/env node
// Fault-test helper only: hold one file-search worker beyond spawn_gap.
import { spawnSync } from "node:child_process"
const args = process.argv.slice(2)
if (args.includes("file-tools-slow-probe")) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 12000)
const r = spawnSync(process.env.GHA_MCP_TEST_REAL_RG || "rg", args, { stdio: "inherit" })
if (r.error) console.error(r.error.code, r.error.message)
process.exit(r.status ?? 2)
