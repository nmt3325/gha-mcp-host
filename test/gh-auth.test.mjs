import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { childEnv } from "../lib/shell.mjs";

// Run the real composite-action shell block. Only gh is replaced: all tokens,
// config files and Git settings belong to an isolated, offline test fixture.
const action = fs.readFileSync(new URL("../.github/actions/run-agent/action.yml", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const name = "    - name: Install PAT credentials without exposing the token to commands\n";
assert.equal(action.split(name).length, 2);
const step = action.split(name)[1].split("\n    - name: ")[0];
const run = step.split("      run: |\n")[1];
assert.ok(run);
const script = run.split("\n").map(line => line.startsWith("        ") ? line.slice(8) : line).join("\n");
const TOKEN = "fixture-pat-not-a-real-github-token";

function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(GIT_|GCM_|GH_|GHA_MCP_|BROKER_|ACTIONS_|INPUT_)/i.test(key) || /^GITHUB_(TOKEN|ENV)$/i.test(key)) delete env[key];
  }
  return env;
}

let bash = "bash";
if (process.platform === "win32") {
  const result = spawnSync("git", ["--exec-path"], { env: cleanEnv(), encoding: "utf8", timeout: 15000, windowsHide: true });
  assert.equal(result.status, 0);
  bash = path.resolve(result.stdout.trim(), "../../..", "bin/bash.exe");
}

function fixture(t, runnerOS, { token = TOKEN, loginExit = 0, missingGh = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gha-gh-auth-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const temp = path.join(root, "runner temp ' and $cash");
  fs.mkdirSync(temp);
  const empty = path.join(root, "empty-config");
  fs.writeFileSync(empty, "");
  const log = path.join(root, "gh-call.json");
  const mock = path.join(root, "mock-gh.mjs");
  fs.writeFileSync(mock, `
    import fs from "node:fs";
    import path from "node:path";
    const input = fs.readFileSync(0, "utf8");
    fs.writeFileSync(process.env.AUTH_TEST_LOG, JSON.stringify({
      args: process.argv.slice(2), input, config: process.env.GH_CONFIG_DIR,
      tokenEnvironment: ["GH_TOKEN", "GITHUB_TOKEN"].filter(k => process.env[k]),
    }), { mode: 0o600 });
    const exit = Number(process.env.AUTH_TEST_EXIT);
    if (exit) process.exit(exit);
    fs.mkdirSync(process.env.GH_CONFIG_DIR, { recursive: true });
    // Deliberately start permissive: the action must enforce its final mode.
    fs.writeFileSync(path.join(process.env.GH_CONFIG_DIR, "hosts.yml"),
      "github.com:\\n  oauth_token: " + JSON.stringify(input.trim()) + "\\n", { mode: 0o644 });
  `);
  // A Bash function works under Git for Windows too, without PATH shims that
  // might accidentally fall through to the runner's real, authenticated gh.
  const shim = 'gh() { node "$AUTH_TEST_MOCK" "$@"; }\n' + (missingGh ? `
    command() {
      if [ "$#" -eq 2 ] && [ "$1" = "-v" ] && [ "$2" = "gh" ]; then return 1; fi
      builtin command "$@"
    }
  ` : "");
  const file = path.join(root, "setup.sh");
  fs.writeFileSync(file, shim + script);
  const envFile = path.join(root, "github-env");
  const result = spawnSync(bash, ["--noprofile", "--norc", "-e", "-o", "pipefail", file], {
    cwd: root, encoding: "utf8", timeout: 15000, windowsHide: true,
    env: {
      ...cleanEnv(), RUNNER_TEMP: temp, RUNNER_OS: runnerOS,
      GHA_MCP_PAT: token, GITHUB_ENV: envFile,
      GIT_CONFIG_SYSTEM: empty, GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never",
      AUTH_TEST_MOCK: mock, AUTH_TEST_LOG: log, AUTH_TEST_EXIT: String(loginExit),
    },
  });
  assert.equal(result.error, undefined, "fixture subprocess must finish");
  assert.ok(!(result.stdout + result.stderr).includes(TOKEN), "token must not appear in setup output");
  return {
    result, log, temp,
    exports: fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8").replace(/\r\n/g, "\n") : "",
    config: path.join(temp, "gha-mcp-gh"),
  };
}

for (const runnerOS of ["Linux", "macOS", "Windows"]) {
  test(`${runnerOS}: authenticates gh through stdin and a private config, not token exports`, t => {
    const f = fixture(t, runnerOS);
    assert.equal(f.result.status, 0, f.result.stderr);
    assert.ok(fs.existsSync(f.log), `gh must be invoked on ${runnerOS}`);
    const call = JSON.parse(fs.readFileSync(f.log, "utf8"));
    assert.deepEqual(call.args, ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--with-token", "--insecure-storage"]);
    assert.equal(call.input, TOKEN + "\n");
    assert.ok(!call.args.join(" ").includes(TOKEN));
    assert.deepEqual(call.tokenEnvironment, []);
    assert.equal(path.resolve(call.config), path.resolve(f.config));
    assert.ok(f.exports.split("\n").includes(`GH_CONFIG_DIR=${call.config}`));
    assert.ok(f.exports.includes("GIT_CONFIG_GLOBAL="));
    assert.ok(!f.exports.includes(TOKEN));
    assert.doesNotMatch(f.exports, /^(GH_TOKEN|GITHUB_TOKEN|GH_PAT|GHA_MCP_PAT)=/m);
    const hosts = path.join(f.config, "hosts.yml");
    assert.ok(fs.readFileSync(hosts, "utf8").includes(TOKEN));
    assert.equal(fs.readFileSync(path.join(f.temp, "gha-mcp-credentials"), "utf8"), `https://x-access-token:${TOKEN}@github.com\n`);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(f.config).mode & 0o777, 0o700);
      assert.equal(fs.statSync(hosts).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.join(f.temp, "gha-mcp-credentials")).mode & 0o777, 0o600);
    }
  });

  test(`${runnerOS}: absent PAT does not invoke gh or publish an authenticated config`, t => {
    const f = fixture(t, runnerOS, { token: "", missingGh: true });
    assert.equal(f.result.status, 0, f.result.stderr);
    assert.equal(fs.existsSync(f.log), false);
    assert.equal(fs.existsSync(path.join(f.config, "hosts.yml")), false);
    assert.ok(!f.exports.includes("GH_CONFIG_DIR="));
    assert.ok(f.exports.includes("GIT_CONFIG_GLOBAL="));
    assert.equal(fs.readFileSync(path.join(f.temp, "gha-mcp-credentials"), "utf8"), "");
  });

  test(`${runnerOS}: rejected gh login fails setup instead of reporting success`, t => {
    const f = fixture(t, runnerOS, { loginExit: 17 });
    assert.equal(f.result.status, 17);
    assert.ok(fs.existsSync(f.log));
    assert.ok(!f.exports.includes("GH_CONFIG_DIR="));
    assert.ok(!f.result.stdout.includes("gh credentials installed"));
  });

  test(`${runnerOS}: supplied PAT with missing gh fails clearly`, t => {
    const f = fixture(t, runnerOS, { missingGh: true });
    assert.equal(f.result.status, 1);
    assert.match(f.result.stdout, /::error::gh is required/);
    assert.equal(fs.existsSync(f.log), false);
    assert.ok(!f.exports.includes("GH_CONFIG_DIR="));
  });
}

test("ordinary command environments retain config paths but scrub credential values", () => {
  const values = {
    GH_CONFIG_DIR: "fixture-gh-config", GIT_CONFIG_GLOBAL: "fixture-git-config",
    GH_TOKEN: TOKEN, GITHUB_TOKEN: TOKEN, GH_PAT: TOKEN, GHA_MCP_PAT: TOKEN,
    BROKER_SECRET: TOKEN, ACTIONS_RUNTIME_TOKEN: TOKEN, INPUT_GH_PAT: TOKEN,
  };
  const before = new Map(Object.keys(values).map(k => [k, process.env[k]]));
  try {
    Object.assign(process.env, values);
    const env = childEnv();
    assert.equal(env.GH_CONFIG_DIR, values.GH_CONFIG_DIR);
    assert.equal(env.GIT_CONFIG_GLOBAL, values.GIT_CONFIG_GLOBAL);
    for (const key of Object.keys(values).filter(k => !["GH_CONFIG_DIR", "GIT_CONFIG_GLOBAL"].includes(k))) {
      assert.equal(env[key], undefined, `${key} must be scrubbed`);
    }
  } finally {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
