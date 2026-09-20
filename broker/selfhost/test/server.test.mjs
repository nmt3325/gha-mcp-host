import test from "node:test"
import assert from "node:assert/strict"
import { createServer, request as httpRequest } from "node:http"
import { createHash, createHmac } from "node:crypto"
import { once } from "node:events"
import { mkdtempSync, rmSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { startServer } from "../dist/server.mjs"

const settings = {
  HOST: "127.0.0.1", PORT: "0", GITHUB_OWNER: "test", GITHUB_REPO: "runner",
  MCP_AUTH_TOKEN: "test-client-token", BROKER_SECRET: "test-enroll-secret",
  GITHUB_PAT_DISPATCH: "test-dispatch-token", MAX_ENV_CREATES_PER_HOUR: "1",
}

test("fails fast when secrets are missing", async () => {
  await assert.rejects(startServer({ ...settings, MCP_AUTH_TOKEN: "" }), /MCP_AUTH_TOKEN is required/)
  await assert.rejects(startServer({ ...settings, PUBLIC_URL: "https://example.com/subpath" }), /PUBLIC_URL/)
})

test("HTTP, MCP, enrollment, execution, SSE and restart work without Cloudflare", { timeout: 30_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "gha-http-test-"))
  let broker
  const dispatched = []
  const github = createServer((req, res) => {
    let body = ""
    req.on("data", (chunk) => { body += chunk })
    req.on("end", () => {
      res.setHeader("content-type", "application/json")
      if (req.method === "POST" && req.url.endsWith("/dispatches")) {
        assert.equal(req.headers.authorization, "Bearer test-dispatch-token")
        dispatched.push(JSON.parse(body))
        res.end(JSON.stringify({ run: { id: 123, run_attempt: 1, html_url: "https://example.com/run/123" } }))
      } else if (req.method === "POST" && req.url.endsWith("/cancel")) {
        res.writeHead(202); res.end("{}")
      } else { res.writeHead(404); res.end("{}") }
    })
  })
  github.listen(0, "127.0.0.1")
  await once(github, "listening")
  const env = { ...settings, DATA_DIR: directory, GITHUB_API_BASE: `http://127.0.0.1:${github.address().port}` }
  t.after(async () => {
    await broker?.close()
    github.closeAllConnections()
    await new Promise((r) => github.close(r))
    rmSync(directory, { recursive: true, force: true })
  })
  broker = await startServer(env)
  await assert.rejects(startServer(env), /already in use/)

  let id = 0
  async function rpc(method, params = {}) {
    const requestId = ++id
    const response = await fetch(`${broker.origin}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${settings.MCP_AUTH_TOKEN}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }),
      signal: AbortSignal.timeout(18_000),
    })
    const text = await response.text()
    assert.equal(response.status, 200, text)
    const messages = response.headers.get("content-type")?.includes("text/event-stream")
      ? text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5).trim()))
      : [JSON.parse(text)]
    const reply = messages.find((message) => message.id === requestId)
    assert.ok(reply, text)
    assert.equal(reply.error, undefined, text)
    return { result: reply.result, messages }
  }
  async function tool(name, args = {}, meta) {
    return rpc("tools/call", { name, arguments: args, ...(meta ? { _meta: meta } : {}) })
  }
  async function agent(action, token, body) {
    const response = await fetch(`${broker.origin}/agent/${envId}/${action}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5000),
    })
    assert.equal(response.status, 200)
    return response.json()
  }

  assert.equal((await fetch(`${broker.origin}/healthz`)).status, 200)
  assert.equal((await fetch(`${broker.origin}/missing`)).status, 404)
  assert.equal((await fetch(`${broker.origin}/mcp`, { method: "POST" })).status, 401)
  assert.equal((await fetch(`${broker.origin}/mcp`, { method: "POST", headers: { authorization: `Bearer ${settings.BROKER_SECRET}` } })).status, 401)
  // fetch intentionally ignores a caller-supplied Host; exercise the wire
  // header using node:http rather than accidentally testing the normal host.
  const rejectedHost = await new Promise((resolveStatus, reject) => {
    const req = httpRequest(`${broker.origin}/healthz`, { headers: { host: "attacker.example" } }, (res) => {
      res.resume()
      res.on("end", () => resolveStatus(res.statusCode))
    })
    req.on("error", reject)
    req.end()
  })
  assert.equal(rejectedHost, 403)
  assert.equal((await fetch(`${broker.origin}/healthz`, { headers: { origin: "https://attacker.example" } })).status, 403)
  assert.equal((await fetch(`${broker.origin}/agent/linux-00000000/next`)).status, 404)
  assert.equal(readdirSync(join(directory, "environments")).length, 0)
  const initialized = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } })
  assert.equal(initialized.result.protocolVersion, "2025-06-18")
  const listed = await rpc("tools/list")
  for (const name of [
    "env_create", "env_status", "env_list", "env_extend", "env_destroy",
    "execute", "start_command", "poll_job", "stop_job", "without_sandbox",
    "read_file", "write_file", "list_directory", "get_image", "get_file",
  ]) {
    assert.ok(listed.result.tools.some((tool) => tool.name === name), name)
  }

  const created = (await tool("env_create", { platform: "linux", ttl_minutes: 10 })).result.structuredContent
  assert.equal(created.ok, true, JSON.stringify(created))
  assert.equal(created.state, "provisioning")
  const envId = created.env_id
  assert.equal(dispatched.length, 1)
  assert.equal(dispatched[0].inputs.env_id, envId)
  const ts = String(Math.floor(Date.now() / 1000))
  const nonce = "test-nonce"
  const signature = createHmac("sha256", settings.BROKER_SECRET).update([envId, "123", "1", nonce, ts].join("\n")).digest("hex")
  const hello = () => fetch(`${broker.origin}/agent/${envId}/hello`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-run-id": "123", "x-run-attempt": "1", "x-nonce": nonce, "x-ts": ts, "x-sig": signature },
    body: JSON.stringify({ shells: { bash: "/bin/bash" }, work_dir: "/tmp/test", platform: "linux" }),
  })
  const enrolled = await hello()
  assert.equal(enrolled.status, 200)
  const agentToken = (await enrolled.json()).agent_token
  assert.ok(agentToken)
  assert.equal((await hello()).status, 409, "enrollment must remain one-shot")
  assert.equal((await fetch(`${broker.origin}/agent/${envId}/next`, { headers: { authorization: `Bearer ${settings.MCP_AUTH_TOKEN}` } })).status, 401)

  // A generic binary file must cross the MCP boundary exactly once as a native
  // embedded resource, both through get_file and the cached-client get_image route.
  const fileBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff])
  const fileBase64 = fileBytes.toString("base64")
  for (const toolName of ["get_file", "get_image"]) {
    const filePending = tool(toolName, { env_id: envId, path: "/tmp/artifact.zip" })
    let fileClaimed
    for (let attempt = 0; attempt < 5 && !fileClaimed; attempt++) {
      fileClaimed = (await agent("next?wait=1&worker=0", agentToken)).command
    }
    assert.ok(fileClaimed, `${toolName} must enqueue a claimable encoder command`)
    assert.equal(fileClaimed.command, "base64 -w 0 -- '/tmp/artifact.zip'")
    const encodedOutput = Buffer.from(fileBase64)
    await agent("chunk", agentToken, {
      command_id: fileClaimed.command_id, start_byte: 0, bytes_b64: encodedOutput.toString("base64"),
      total_bytes: encodedOutput.length, state: "exited", exit_code: 0, eof: true, cwd_after: "/tmp/test",
    })
    const fileResult = (await filePending).result
    assert.equal(fileResult.structuredContent.file_name, "artifact.zip")
    assert.equal(fileResult.structuredContent.mime_type, "application/zip")
    assert.equal(fileResult.structuredContent.bytes, fileBytes.length)
    assert.equal(fileResult.structuredContent.sha256, createHash("sha256").update(fileBytes).digest("hex"))
    assert.equal(fileResult.content[1].type, "resource")
    assert.equal(fileResult.content[1].resource.mimeType, "application/zip")
    assert.equal(fileResult.content[1].resource.blob, fileBase64)
    assert.equal(fileResult.structuredContent._mcp_content, undefined)
    assert.equal(fileResult.content[0].text.includes(fileBase64), false, "base64 must not be duplicated into JSON text")
  }

  // The broker quotes every argv element, so the runner never sees a command
  // line it has to re-split. Asserting on the rendered form is what keeps that
  // honest: a regression to string commands would change this.
  const quote = (word) => "'" + word.split("'").join("'\\''") + "'"
  const rendered = (argv) => argv.map(quote).join(" ")
  async function runCommand(argv, delay = 0, progress = false) {
    const pending = tool("execute", { env_id: envId, command: argv, wait_ms: 12000 }, progress ? { progressToken: "test-progress" } : undefined)
    let claimed
    for (let attempt = 0; attempt < 5 && !claimed; attempt++) {
      claimed = (await agent("next?wait=1&worker=0", agentToken)).command
    }
    assert.ok(claimed, "execute must enqueue a claimable command")
    assert.equal(claimed.command, rendered(argv), "the runner must receive the argv, quoted")
    if (delay) await sleep(delay)
    const output = Buffer.from("hello from the runner\n")
    await agent("chunk", agentToken, {
      command_id: claimed.command_id, start_byte: 0, bytes_b64: output.toString("base64"),
      total_bytes: output.length, state: "exited", exit_code: 0, eof: true, cwd_after: "/tmp/test",
    })
    const result = await pending
    assert.equal(result.result.structuredContent.state, "exited", JSON.stringify(result))
    assert.equal(result.result.structuredContent.output, output.toString())
    if (progress) assert.ok(result.messages.some((message) => message.method === "notifications/progress"), JSON.stringify(result.messages))
    return result.result.structuredContent
  }
  const executed = await runCommand(["echo", "example"])
  const reread = (await tool("poll_job", { env_id: envId, job_id: executed.job_id, from_byte: 0 })).result.structuredContent
  assert.equal(reread.output, executed.output)
  assert.deepEqual(Object.keys(reread).sort(), Object.keys(executed).sort())
  const deduped = (await tool("execute", { env_id: envId, command: ["echo", "example"], wait_ms: 12000 })).result.structuredContent
  assert.equal(deduped.deduped, true)
  assert.equal(deduped.job_id, executed.job_id)
  await runCommand(["echo", "progress"], 5300, true)

  await broker.close()
  broker = await startServer(env)
  assert.ok(broker.origin)
  const restored = (await tool("poll_job", { env_id: envId, job_id: executed.job_id, from_byte: 0 })).result.structuredContent
  assert.equal(restored.state, "exited")
  assert.equal(restored.output, executed.output, "terminal output must survive process restart")
  const status = (await tool("env_status", { env_id: envId })).result.structuredContent
  assert.equal(status.state, "ready")
  assert.equal((await agent("control", agentToken, { wait: 1, running: [] })).destroy, false)
  const rate = (await tool("env_create", { platform: "linux" })).result.structuredContent
  assert.equal(rate.error.code, "rate_capped", "guard state must survive restart")
  assert.equal(dispatched.length, 1)
  const extended = (await tool("env_extend", { env_id: envId, minutes: 1 })).result.structuredContent
  assert.equal(extended.ok, true)
  const aborted = new AbortController()
  const longPoll = fetch(`${broker.origin}/agent/${envId}/next?wait=50`, { headers: { authorization: `Bearer ${agentToken}` }, signal: aborted.signal })
  await sleep(30)
  aborted.abort()
  await assert.rejects(longPoll, { name: "AbortError" })
  const destroyed = (await tool("env_destroy", { env_id: envId })).result.structuredContent
  assert.equal(destroyed.cancel_status, 202)
  assert.equal((await fetch(`${broker.origin}/agent/${envId}/next`, { headers: { authorization: `Bearer ${agentToken}` } })).status, 410)
})
