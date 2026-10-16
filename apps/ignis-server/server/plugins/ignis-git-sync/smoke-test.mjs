#!/usr/bin/env node
"use strict";

/**
 * Smoke test for ignis-git-sync: boots a real Ignis server on a temp vault
 * with a local bare "remote", then verifies the full auto-sync loop:
 * setup -> write files via the real /api/fs routes -> auto commit+push ->
 * gitignore of volatile state -> conflict halt -> force resume.
 *
 * Run from the ignis repo root:
 *   GIT_SYNC_POLL_MS=1000 node apps/ignis-server/server/plugins/ignis-git-sync/smoke-test.mjs
 */

import { spawn, execFile } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";

const execFileP = promisify(execFile);

const PORT = 18434;
const BASE = `http://127.0.0.1:${PORT}`;

const work = mkdtempSync(path.join(tmpdir(), "ignis-git-sync-test-"));
const logs = [];

const vaults = path.join(work, "vaults");
const data = path.join(work, "data");
const vaultName = "TestVault";
const vaultPath = path.join(vaults, vaultName);
const remote = path.join(work, "remote.git");

let failures = 0;
let server = null;

function check(label, cond, detail = "") {
  if (cond) {
    console.log(`  ok: ${label}`);
  } else {
    failures++;
    console.error(`  FAIL: ${label} ${detail}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function apiPost(pathname, body) {
  const res = await fetch(`${BASE}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function apiGet(pathname) {
  const res = await fetch(`${BASE}${pathname}`);
  return { status: res.status, body: await res.json() };
}

async function remoteHasFile(file) {
  try {
    const { stdout } = await execFileP("git", [
      "-C", remote, "cat-file", "-p", `HEAD:${file}`,
    ]);
    return stdout;
  } catch {
    return null;
  }
}

async function waitFor(condFn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      if (await condFn()) {
        return true;
      }
    } catch {}
    await sleep(500);
  }

  throw new Error(`timeout waiting for: ${label}`);
}

async function main() {
  mkdirSync(vaultPath, { recursive: true });
  mkdirSync(data, { recursive: true });

  writeFileSync(path.join(vaultPath, "existing.md"), "# Existing\nfirst note\n");

  // volatile UI state that must be gitignored
  mkdirSync(path.join(vaultPath, ".obsidian"), { recursive: true });
  writeFileSync(path.join(vaultPath, ".obsidian", "workspace.json"), '{"layout":1}');

  writeFileSync(
    path.join(data, "plugin-config.json"),
    JSON.stringify({ "ignis-git-sync": { enabledVaults: [vaultName] } }),
  );

  // local bare remote
  await execFileP("git", ["init", "--bare", "-b", "main", remote]);

  const env = {
    ...process.env,
    VAULT_ROOT: vaults,
    DATA_ROOT: data,
    PORT: String(PORT),
    GIT_SYNC_POLL_MS: "1000",
    GIT_AUTHOR_NAME: "Test",
    GIT_COMMITTER_NAME: "Test",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_EMAIL: "t@t",
  };

  server = spawn(process.execPath, ["apps/ignis-server/server/index.js"], {
    cwd: path.resolve("."),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  server.stdout.on("data", (d) => logs.push(d.toString()));
  server.stderr.on("data", (d) => logs.push(d.toString()));

  await waitFor(async () => (await apiGet("/api/version")).status === 200, 60000, "server start");
  console.log("server up");

  // --- setup: init + configure remote ---
  const cfg = await apiPost("/api/ext/ignis-git-sync/config", {
    vault: vaultName,
    remote,
    branch: "main",
  });
  check("config saved", cfg.status === 200 && cfg.body.config.remote === remote, JSON.stringify(cfg.body));

  const setup = await apiPost("/api/ext/ignis-git-sync/setup", {
    vault: vaultName,
    mode: "init",
  });
  check("setup init ok", setup.status === 200 && setup.body.vault.state !== "conflict", JSON.stringify(setup.body));

  // initial content reaches the remote
  await waitFor(() => remoteHasFile("existing.md"), 20000, "initial push");
  check("existing.md pushed to remote", true);
  const ws = await remoteHasFile(".obsidian/workspace.json");
  check("workspace.json NOT pushed (gitignored)", ws === null);
  const gi = await remoteHasFile(".gitignore");
  check(".gitignore pushed and contains managed block", (gi || "").includes("ignis-git-sync managed"));

  // --- auto sync: write via the real fs API ---
  await fetch(`${BASE}/api/fs/writeFile?vault=${encodeURIComponent(vaultName)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "AI/agent.md", content: "# Agent\nmade by smoke test\n" }),
  });

  await waitFor(() => remoteHasFile("AI/agent.md"), 20000, "agent.md push");
  check("API-written file auto-pushed", true);

  // --- status endpoint ---
  const status = await apiGet("/api/ext/ignis-git-sync/status");
  const vs = status.body.vaults.find((v) => v.vaultId === vaultName);
  check("status shows vault", Boolean(vs) && ["idle", "syncing"].includes(vs.state), JSON.stringify(vs));
  check("status has lastCommit", Boolean(vs?.lastCommit?.at));

  // --- manual sync is a no-op when clean ---
  const manual = await apiPost("/api/ext/ignis-git-sync/sync", { vault: vaultName });
  check("manual sync ok", manual.status === 200, JSON.stringify(manual.body));

  // --- conflict: remote moves a file the local side also edits ---
  // push a remote change to shared.md
  const cloneDir = path.join(work, "remoteclone");
  await execFileP("git", ["clone", remote, cloneDir]);
  writeFileSync(path.join(cloneDir, "shared.md"), "remote version\n");
  await execFileP("git", ["-C", cloneDir, "add", "-A"]);
  await execFileP("git", ["-C", cloneDir, "commit", "-m", "remote edit"]);
  await execFileP("git", ["-C", cloneDir, "push", "origin", "main"]);

  // local edit to the same file (bypass the server so it commits fast)
  writeFileSync(path.join(vaultPath, "shared.md"), "local version\n");

  await waitFor(async () => {
    const s = await apiGet("/api/ext/ignis-git-sync/status");
    const v = s.body.vaults.find((x) => x.vaultId === vaultName);
    return v && v.state === "conflict";
  }, 30000, "conflict state");
  check("conflict detected and auto-sync halted", true);

  // halted: further changes must not be pushed while halted
  writeFileSync(path.join(vaultPath, "while-halted.md"), "should not appear yet\n");
  await sleep(4000);
  check("no push while halted", (await remoteHasFile("while-halted.md")) === null);

  // --- resolve manually and force-resume ---
  // Human resolution choice: take the remote version (git reset --hard),
  // keeping untracked local files (while-halted.md) for the next sync.
  await execFileP("git", ["-C", vaultPath, "fetch", "origin", "main"]);
  await execFileP("git", ["-C", vaultPath, "reset", "--hard", "origin/main"]);

  const resume = await apiPost("/api/ext/ignis-git-sync/sync", {
    vault: vaultName,
    force: true,
  });
  check("force sync accepted", resume.status === 200, JSON.stringify(resume.body));

  // after resolution, local unpushed content eventually lands
  await waitFor(async () => {
    await apiPost("/api/ext/ignis-git-sync/sync", { vault: vaultName, force: true }).catch(() => {});
    return (await remoteHasFile("while-halted.md")) !== null;
  }, 30000, "resume push");
  check("sync resumed after force", true);

  console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((e) => {
    console.error(`fatal: ${e.message}`);
    console.error(logs ? logs.join("") : "");
    process.exitCode = 1;
  })
  .finally(() => {
    if (server) {
      server.kill("SIGTERM");
    }
    setTimeout(() => {
      try {
        rmSync(work, { recursive: true, force: true });
      } catch {}
    }, 500);
  });
