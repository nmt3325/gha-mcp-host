#!/usr/bin/env bash
# End-to-end regression suite. No network, no Actions minutes, no real dispatch.
#
#   bash test/e2e.sh
#
# Boots `wrangler dev`, boots the mock runner + fake GitHub, then drives the real
# MCP endpoint with curl.
#
# Assertion 1, which outranks every functional check here: NO TOOL CALL MAY EVER
# TAKE LONGER THAN 55 SECONDS, under any fault. A tool that exceeds the client's
# ceiling produces `MCP error -32001: Request timed out`, and at that point the
# caller has lost the command_id and cannot even find out what happened. Every
# scenario below is timed and fails the suite if it crosses the line.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
PORT="${PORT:-8787}"
GH_PORT="${GH_PORT:-8788}"
BASE="http://127.0.0.1:${PORT}"
TOKEN="devtoken"
SECRET="devsecret"
MAX_SECONDS=55
# The SDK's streamable-HTTP transport rejects a request whose Accept header does
# not list both types, and replies in SSE frames rather than a bare JSON body.
ACCEPT='accept: application/json, text/event-stream'
# `mcp()` is always called inside $( ), so a variable it assigns dies with the
# subshell. It reports its timing through a file instead.
LAST_FILE="$(mktemp)"

PASS=0
FAIL=0
RPC_ID=0

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
dim()   { printf '\033[2m%s\033[0m\n' "$*"; }

cleanup() {
	[[ -n "${MOCK_PID:-}" ]] && kill "$MOCK_PID" 2>/dev/null
	[[ -n "${DEV_PID:-}" ]] && kill "$DEV_PID" 2>/dev/null
	rm -f "${LAST_FILE:-}"
	wait 2>/dev/null
}
trap cleanup EXIT

# --------------------------------------------------------------- boot

cat > "$ROOT/.dev.vars" <<EOF
MCP_AUTH_TOKEN = "$TOKEN"
BROKER_SECRET = "$SECRET"
GITHUB_PAT_DISPATCH = "devpat"
GITHUB_API_BASE = "http://127.0.0.1:${GH_PORT}"
EOF

dim "starting wrangler dev on :$PORT"
( cd "$ROOT" && npx wrangler dev --port "$PORT" --local >/tmp/gha-mcp-dev.log 2>&1 ) &
DEV_PID=$!

for _ in $(seq 1 60); do
	curl -fsS "$BASE/healthz" >/dev/null 2>&1 && break
	sleep 1
done
if ! curl -fsS "$BASE/healthz" >/dev/null 2>&1; then
	red "wrangler dev never became healthy; see /tmp/gha-mcp-dev.log"
	tail -40 /tmp/gha-mcp-dev.log
	exit 1
fi

dim "starting mock runner + fake github on :$GH_PORT"
node "$HERE/mock-runner.mjs" --broker="$BASE" --gh-port="$GH_PORT" --secret="$SECRET" --workers=2 \
	>/tmp/gha-mcp-mock.log 2>&1 &
MOCK_PID=$!
sleep 1

# --------------------------------------------------------------- helpers

# unsse <raw-body> -> the JSON-RPC reply, whether it arrived as JSON or as SSE.
# Every assertion below treats a reply as plain JSON; this is the one place that
# knows the transport may have framed it.
unsse() {
	printf '%s' "$1" | node -e '
		let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
			if(!/^data:/m.test(s))return process.stdout.write(s)
			process.stdout.write(s.split(/\r?\n/).filter(l=>l.startsWith("data:")).map(l=>l.slice(5).trim()).join(""))
		})'
}

# mcp <tool> <json-args>  -> prints structuredContent, records seconds in $LAST_FILE
mcp() {
	RPC_ID=$((RPC_ID + 1))
	local started ended
	started=$(date +%s)
	local out
	out=$(curl -sS -X POST "$BASE/mcp" \
		-H "authorization: Bearer $TOKEN" \
		-H 'content-type: application/json' \
		-H "$ACCEPT" \
		--max-time 120 \
		-d "{\"jsonrpc\":\"2.0\",\"id\":$RPC_ID,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}")
	ended=$(date +%s)
	printf '%s' "$((ended - started))" > "$LAST_FILE"
	out=$(unsse "$out")
	printf '%s' "$out" | node -e '
		let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
			try{const j=JSON.parse(s);process.stdout.write(JSON.stringify(j.result?.structuredContent ?? j))}
			catch{process.stdout.write(s)}
		})'
}

# field <json> <dotted.path>
field() {
	printf '%s' "$1" | node -e '
		const p=process.argv[1].split(".");let s="";
		process.stdin.on("data",d=>s+=d).on("end",()=>{
			let v;try{v=JSON.parse(s)}catch{return process.stdout.write("")}
			for(const k of p){if(v==null)break;v=v[k]}
			process.stdout.write(v===undefined||v===null?"":typeof v==="object"?JSON.stringify(v):String(v))
		})' "$2"
}

check() { # check <label> <condition-result> <detail>
	if [[ "$2" == "1" ]]; then
		PASS=$((PASS + 1)); green "  PASS  $1"
	else
		FAIL=$((FAIL + 1)); red   "  FAIL  $1"; [[ -n "${3:-}" ]] && dim "        $3"
	fi
}

check_time() { # the assertion that outranks all others
	local LAST_SECONDS
	LAST_SECONDS=$(cat "$LAST_FILE" 2>/dev/null || echo 0)
	if [[ "${LAST_SECONDS:-0}" -le "$MAX_SECONDS" ]]; then
		PASS=$((PASS + 1)); green "  PASS  $1 returned in ${LAST_SECONDS}s"
	else
		FAIL=$((FAIL + 1)); red   "  FAIL  $1 took ${LAST_SECONDS}s (> ${MAX_SECONDS}s: this is the -32001 failure)"
	fi
}

eq() { [[ "$1" == "$2" ]] && echo 1 || echo 0; }

# --------------------------------------------------------------- protocol

echo
echo "== MCP protocol =="
INIT=$(unsse "$(curl -sS -X POST "$BASE/mcp" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -H "$ACCEPT" \
	-d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"e2e","version":"0"}}}')")
check "initialize returns a protocolVersion" "$(eq "$(field "$INIT" result.protocolVersion)" "2025-06-18")" "$INIT"

UNAUTH=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/mcp" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
check "unauthenticated /mcp is rejected" "$(eq "$UNAUTH" "401")" "got $UNAUTH"

LIST=$(unsse "$(curl -sS -X POST "$BASE/mcp" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -H "$ACCEPT" \
	-d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}')")
TOOL_COUNT=$(printf '%s' "$LIST" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(String(j.result.tools.length))})')
check "tools/list exposes all 14 tools" "$(eq "$TOOL_COUNT" "14")" "got $TOOL_COUNT"

# --------------------------------------------------------------- lifecycle

echo
echo "== environment lifecycle =="
R=$(mcp env_create '{"platform":"linux","label":"e2e","wait":true,"ttl_minutes":15}')
check_time "env_create"
ENV_ID=$(field "$R" env_id)
check "env_create succeeded" "$(eq "$(field "$R" ok)" "true")" "$R"
check "env reached ready" "$(eq "$(field "$R" state)" "ready")" "state=$(field "$R" state)"
dim "        env_id=$ENV_ID"

R=$(mcp env_list '{}')
check_time "env_list"
check "env_list finds it via the run name" "$(printf '%s' "$R" | grep -q "$ENV_ID" && echo 1 || echo 0)" "$R"

# ------------------------------------------------------- execute basics

echo
echo "== execute =="
R=$(mcp execute "{\"env_id\":\"$ENV_ID\",\"command\":[\"sim:echo\",\"hello\",\"world\"]}")
check_time "execute (fast command)"
check "state is exited" "$(eq "$(field "$R" state)" "exited")" "$R"
check "exit_code is 0" "$(eq "$(field "$R" exit_code)" "0")" "$R"
check "returned_because is exit" "$(eq "$(field "$R" returned_because)" "exit")" "$R"
check "eof is true" "$(eq "$(field "$R" eof)" "true")" "$R"
check "output carries the text" "$(printf '%s' "$(field "$R" output)" | grep -q 'hello world' && echo 1 || echo 0)" "$(field "$R" output)"
check "poll_error is absent on the happy path" "$(eq "$(field "$R" poll_error)" "")" "$(field "$R" poll_error)"

R=$(mcp execute "{\"env_id\":\"$ENV_ID\",\"command\":[\"sim:exit\",\"42\"]}")
check "non-zero exit is reported, not thrown" "$(eq "$(field "$R" exit_code)" "42")" "$R"
check "ok stays true for a non-zero exit" "$(eq "$(field "$R" ok)" "true")" "a failing command is data, not a tool error"

# --------------------------------------------------------------- identical shape

echo
echo "== execute and poll_job return the same key set =="
A=$(mcp execute "{\"env_id\":\"$ENV_ID\",\"command\":[\"sim:echo\",\"shape\"]}")
CID=$(field "$A" job_id)
B=$(mcp poll_job "{\"env_id\":\"$ENV_ID\",\"job_id\":\"$CID\",\"from_byte\":0}")
SAME=$(node -e '
	const a=Object.keys(JSON.parse(process.argv[1])).sort().join(",")
	const b=Object.keys(JSON.parse(process.argv[2])).sort().join(",")
	process.stdout.write(a===b?"1":"0:"+a+" != "+b)
' "$A" "$B")
check "identical keys" "$(eq "${SAME:0:1}" "1")" "$SAME"

# --------------------------------------------------------------- dedupe

echo
echo "== idempotency =="
mcp execute "{\"env_id\":\"$ENV_ID\",\"command\":[\"sim:echo\",\"dupe-me\"]}" >/dev/null
R=$(mcp execute "{\"env_id\":\"$ENV_ID\",\"command\":[\"sim:echo\",\"dupe-me\"]}")
check "an identical command dedupes" "$(eq "$(field "$R" deduped)" "true")" "$R"
R=$(mcp execute "{\"env_id\":\"$ENV_ID\",\"command\":[\"sim:echo\",\"dupe-me\"],\"allow_duplicate\":true}")
check "allow_duplicate forces a re-run" "$(eq "$(field "$R" deduped)" "false")" "$R"

# --------------------------------------------------------------- long jobs

echo
echo "== a long job never blocks past the cap =="
R=$(mcp execute "{\"env_id\":\"$ENV_ID\",\"command\":[\"sim:drip\",\"40\",\"1000\"],\"wait_ms\":8000}")
check_time "execute on a 40s job"
CID=$(field "$R" job_id)
check "returns while still running" "$(eq "$(field "$R" state)" "running")" "state=$(field "$R" state)"
check "tells the caller what to do next" "$(printf '%s' "$(field "$R" next_action)" | grep -q poll_job && echo 1 || echo 0)" "$(field "$R" next_action)"

NEXT=$(field "$R" next_byte)
R=$(mcp poll_job "{\"env_id\":\"$ENV_ID\",\"job_id\":\"$CID\",\"from_byte\":$NEXT,\"wait_ms\":5000,\"until\":\"any_output\"}")
check_time "poll_job resume"
check "resumes from the offset" "$(eq "$(field "$R" start_byte)" "$NEXT")" "$R"

R=$(mcp poll_job "{\"env_id\":\"$ENV_ID\",\"job_id\":\"$CID\",\"from_byte\":0,\"wait_ms\":45000,\"until\":\"exit\"}")
check_time "poll_job until exit (worst case)"

mcp stop_job "{\"env_id\":\"$ENV_ID\",\"job_id\":\"$CID\"}" >/dev/null

# --------------------------------------------------------------- hang

echo
echo "== a command that goes silent forever =="
R=$(mcp execute "{\"env_id\":\"$ENV_ID\",\"command\":[\"sim:hang\"],\"wait_ms\":6000}")
check_time "execute on a hanging command"
HANG=$(field "$R" job_id)
check "state is running, never unknown" "$(eq "$(field "$R" state)" "running")" "state=$(field "$R" state)"

R=$(mcp poll_job "{\"env_id\":\"$ENV_ID\",\"job_id\":\"$HANG\",\"from_byte\":0,\"wait_ms\":20000,\"until\":\"exit\"}")
check_time "poll_job until exit on a hang"
check "warns that a hang and a healthy build look alike" \
	"$(printf '%s' "$(field "$R" warnings)" | grep -q 'stuck' && echo 1 || echo 0)" "$(field "$R" warnings)"

R=$(mcp stop_job "{\"env_id\":\"$ENV_ID\",\"job_id\":\"$HANG\",\"signal\":\"KILL\"}")
check_time "stop_job"
check "kill reports the tree was killed" "$(eq "$(field "$R" tree_killed)" "true")" "$R"
R=$(mcp poll_job "{\"env_id\":\"$ENV_ID\",\"job_id\":\"$HANG\",\"from_byte\":0,\"wait_ms\":8000,\"until\":\"exit\"}")
check "killed is a terminal state" "$(eq "$(field "$R" state)" "killed")" "state=$(field "$R" state)"

# --------------------------------------------------------------- big output

echo
echo "== output larger than the broker ring =="
R=$(mcp execute "{\"env_id\":\"$ENV_ID\",\"command\":[\"sim:spam\",\"700\"],\"wait_ms\":30000,\"max_bytes\":65536}")
check_time "execute with 700 KiB of output"
BIG=$(field "$R" job_id)
check "the window is capped, not the job" "$(eq "$(field "$R" truncated)" "true")" "truncated=$(field "$R" truncated)"
R=$(mcp poll_job "{\"env_id\":\"$ENV_ID\",\"job_id\":\"$BIG\",\"from_byte\":0,\"max_bytes\":65536,\"wait_ms\":15000}")
check_time "poll_job of an evicted range"
check "evicted bytes are re-served from the runner" \
	"$(printf '%s' "$(field "$R" output)" | test "$(wc -c < /dev/stdin)" -gt 100 && echo 1 || echo 0)" \
	"range_evicted=$(field "$R" range_evicted)"

# --------------------------------------------------------------- runner death

echo
echo "== the runner is SIGKILLed mid-flight =="
R=$(mcp env_create '{"platform":"linux","label":"doomed","wait":true,"ttl_minutes":10}')
DOOMED=$(field "$R" env_id)
mcp execute "{\"env_id\":\"$DOOMED\",\"command\":[\"sim:vanish\"],\"wait_ms\":4000}" >/dev/null
sleep 2
R=$(mcp execute "{\"env_id\":\"$DOOMED\",\"command\":[\"sim:echo\",\"after\",\"death\"],\"wait_ms\":6000}")
check_time "execute against a dead runner"
check "it returns a result instead of timing out" "$(eq "$(field "$R" ok)" "true")" "$R"
check "state is queued or lost, never unknown" \
	"$(printf '%s' "$(field "$R" state)" | grep -Eq '^(queued|lost|running)$' && echo 1 || echo 0)" "state=$(field "$R" state)"
R=$(mcp env_status "{\"env_id\":\"$DOOMED\"}")
check_time "env_status on a dead runner"
mcp env_destroy "{\"env_id\":\"$DOOMED\"}" >/dev/null

# --------------------------------------------------------------- input errors

echo
echo "== bad input is data, not a transport error =="
# Two layers refuse bad input, and neither may surface as a JSON-RPC protocol
# error. A malformed env_id never reaches the handler: the tool's own input
# schema rejects it, and the SDK reports that as a result carrying isError,
# which an agent can read and correct. env_id has been shape-checked this way
# since the exec_* surface, so asking the handler for on_error here could never
# have worked -- the well-shaped case below is the one the handler owns.
R=$(mcp execute '{"env_id":"not-an-id","command":["sim:echo","x"]}')
check "a malformed env_id is refused by the schema" \
	"$(printf '%s' "$R" | grep -q '"isError":true' && echo 1 || echo 0)" "$R"
check "the refusal names the field it rejected" \
	"$(printf '%s' "$R" | grep -q 'env_id' && echo 1 || echo 0)" "$R"
check "a schema refusal is still a result, not a -32xxx" \
	"$(printf '%s' "$R" | grep -q '"error":{"code":-' && echo 0 || echo 1)" "$R"

# A well-shaped id for an environment that does not exist is the handler's own
# case, and that one answers with data: ok false, a stop verdict, and retryable
# as a strict boolean.
R=$(mcp execute '{"env_id":"linux-zzzzzzzz","command":["sim:echo","x"]}')
check "an unknown environment fails as data" "$(eq "$(field "$R" ok)" "false")" "$R"
check "on_error says stop" "$(eq "$(field "$R" on_error)" "stop")" "$(field "$R" on_error)"
check "retryable is a strict boolean false" "$(eq "$(field "$R" retryable)" "false")" "$(field "$R" retryable)"

R=$(mcp execute "{\"env_id\":\"$ENV_ID\",\"command\":[\"   \"]}")
check "a blank program name is refused, not queued" "$(eq "$(field "$R" error.code)" "bad_input")" "$R"

# --------------------------------------------------------------- teardown

echo
echo "== teardown =="
R=$(mcp env_extend "{\"env_id\":\"$ENV_ID\",\"minutes\":20}")
check "env_extend works" "$(eq "$(field "$R" ok)" "true")" "$R"
R=$(mcp env_destroy "{\"env_id\":\"$ENV_ID\"}")
check_time "env_destroy"
check "destroy is confirmed by GitHub accepting the cancel" "$(eq "$(field "$R" cancel_status)" "202")" "$R"

echo
if [[ "$FAIL" -eq 0 ]]; then
	green "$PASS passed, 0 failed"
else
	red "$PASS passed, $FAIL FAILED"
fi
exit $(( FAIL > 0 ? 1 : 0 ))
