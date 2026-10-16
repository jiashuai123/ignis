"use strict";

const fs = require("fs");
const { writeCoalescer } = require("@ignis/server-core");
const git = require("./git");
const configStore = require("./config-store");

const { flushPendingSubtree } = writeCoalescer;

const STATES = {
  IDLE: "idle",
  SYNCING: "syncing",
  ERROR: "error",
  CONFLICT: "conflict",
};

class VaultSync {
  constructor(vaultId, vaultPath, cfg, hooks) {
    this.vaultId = vaultId;
    this.vaultPath = vaultPath;
    this.cfg = cfg;
    this.hooks = hooks; // { onState(vaultId, snapshot) }

    this.state = STATES.IDLE;
    this.halted = false; // set on conflict; auto-sync pauses until resolved
    this.lastError = null;
    this.lastSyncAt = null;
    this.lastCommit = null;
    this.pushPending = false; // commit landed but push failed/skipped
    this.dirty = false;

    this.syncing = false;
    this.resync = false;
    this.debounceTimer = null;
    this.pollTimer = null;
    this._stopped = false;
  }

  snapshot() {
    return {
      vaultId: this.vaultId,
      state: this.state,
      halted: this.halted,
      dirty: this.dirty,
      lastError: this.lastError,
      lastSyncAt: this.lastSyncAt,
      lastCommit: this.lastCommit,
      pushPending: this.pushPending,
      configured: Boolean(this.cfg.remote),
      branch: this.cfg.branch,
    };
  }

  _setState(state, extra = {}) {
    this.state = state;

    if (state === STATES.IDLE) {
      this.lastError = null;
    }

    this.hooks.onState(this.snapshot(), extra);
  }

  updateConfig(cfg) {
    this.cfg = cfg;
    this.restartTimers();
  }

  start() {
    this._stopped = false;
    this.restartTimers();
  }

  stop() {
    this._stopped = true;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  restartTimers() {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this._stopped) {
      return;
    }

    this.schedulePoll();
  }

  schedulePoll() {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }

    const ms = Math.max(1000, this.cfg.pollMs);

    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      this.sync().catch(() => {});
      this.schedulePoll();
    }, ms);

    if (this.pollTimer.unref) {
      this.pollTimer.unref();
    }
  }

  // Called from watcher events (accelerates the poll loop).
  onVaultEvent(event) {
    if (!event || typeof event.path !== "string") {
      return;
    }

    // Our own git operations trigger watcher events; ignore .git and
    // gitignored-state noise so we never loop.
    if (event.path === ".git" || event.path.startsWith(".git/")) {
      return;
    }

    if (this._stopped) {
      return;
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.dirty = true;

    const ms = Math.max(3000, this.cfg.debounceMs);

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.sync().catch(() => {});
    }, ms);

    if (this.debounceTimer.unref) {
      this.debounceTimer.unref();
    }
  }

  /** Manual trigger; force=true resumes a halted (conflict) vault. */
  async syncNow(force = false) {
    if (force) {
      this.halted = false;
    }

    return this.sync();
  }

  async isRepo() {
    try {
      await git.run(this.vaultPath, ["rev-parse", "--is-inside-work-tree"]);
      return true;
    } catch {
      return false;
    }
  }

  async initRepo() {
    // git init (branch per config)
    await git.run(this.vaultPath, ["init", "-b", this.cfg.branch]);
    await git.run(this.vaultPath, ["config", "user.name", this.cfg.author.name]);
    await git.run(this.vaultPath, ["config", "user.email", this.cfg.author.email]);

    await configStore.ensureGitignore(this.vaultPath, this.cfg);
    await git.run(this.vaultPath, ["add", "-A"]);

    // An initial commit is optional; if nothing to commit (empty vault
    // except ignores), create it anyway so push has a HEAD.
    const status = await git.run(this.vaultPath, ["status", "--porcelain"]);

    if (status.stdout.length > 0) {
      await git.run(this.vaultPath, [
        "commit",
        "-m",
        "git-sync: initial commit",
      ]);
    } else {
      await git.run(this.vaultPath, [
        "commit",
        "--allow-empty",
        "-m",
        "git-sync: initial commit",
      ]);
    }

    this.pushPending = true; // initial commit needs a push

    if (this.cfg.remote) {
      await this.setRemote(this.cfg.remote);
    }
  }

  async setRemote(url) {
    try {
      await git.run(this.vaultPath, ["remote", "set-url", "origin", url]);
    } catch {
      await git.run(this.vaultPath, ["remote", "add", "origin", url]);
    }

    this.cfg.remote = url;
  }

  async ensureUpstream() {
    // Make branch track origin/<branch> so push/pull defaults are stable.
    try {
      await git.run(this.vaultPath, [
        "branch",
        "--set-upstream-to",
        `origin/${this.cfg.branch}`,
        this.cfg.branch,
      ]);
    } catch {
      // upstream doesn't exist yet; plain push below creates it
    }
  }

  async sync() {
    if (this.syncing) {
      this.resync = true; // run again after the current cycle
      return this.snapshot();
    }

    if (this.halted && this.state === STATES.CONFLICT) {
      // Auto-sync is paused after a conflict; manual /sync (force) resumes.
      return this.snapshot();
    }

    if (!(await this.isDir())) {
      return this.snapshot();
    }

    this.syncing = true;
    this._setState(STATES.SYNCING);

    try {
      await this._syncCycle();
      this._setState(STATES.IDLE);
      this.lastSyncAt = new Date().toISOString();
    } catch (e) {
      const stderr = e.stderr || "";
      const stdout = e.stdout || "";
      const conflict =
        /conflict/i.test(stderr) ||
        /could not apply/i.test(stderr) ||
        /needs merge/i.test(stderr) ||
        /unresolved/i.test(stderr) ||
        /diverged/i.test(stderr);

      if (conflict) {
        this.halted = true;
        this.lastError = `conflict: ${(stderr || stdout).split("\n")[0]}`;
        this._setState(STATES.CONFLICT);
      } else {
        this.lastError = (stderr || stdout || e.message).split("\n")[0];
        this._setState(STATES.ERROR);
      }
    } finally {
      this.syncing = false;

      if (this.resync) {
        this.resync = false;
        setImmediate(() => this.sync().catch(() => {}));
      }
    }

    return this.snapshot();
  }

  async isDir() {
    try {
      const s = await fs.promises.stat(this.vaultPath);
      return s.isDirectory();
    } catch {
      return false;
    }
  }

  async _syncCycle() {
    // 1. Land any coalesced writes still buffered for this vault.
    try {
      await flushPendingSubtree(this.vaultPath);
    } catch {
      // non-fatal: the pending write retries on its own and re-triggers us
    }

    // 2. Ensure a repo exists.
    if (!(await this.isRepo())) {
      await this.initRepo();
    }

    // 3. Keep author + .gitignore current with plugin config.
    await git.run(this.vaultPath, ["config", "user.name", this.cfg.author.name]);
    await git.run(this.vaultPath, ["config", "user.email", this.cfg.author.email]);
    await configStore.ensureGitignore(this.vaultPath, this.cfg);

    // 4. Commit local changes (if any).
    const status = await git.run(this.vaultPath, ["status", "--porcelain"]);
    const changes = status.stdout ? status.stdout.split("\n").filter(Boolean) : [];

    this.dirty = changes.length > 0;

    let committed = false;

    if (this.dirty) {
      await git.run(this.vaultPath, ["add", "-A"]);

      const commitMsg = `auto-sync: ${changes.length} path(s) changed (${new Date().toISOString()})`;

      try {
        const commit = await git.run(this.vaultPath, ["commit", "-m", commitMsg]);
        committed = true;
        this.lastCommit = {
          message: commitMsg,
          hash: (commit.stdout.match(/\[main|\w+ ([0-9a-f]{7,})/) || [])[1] || null,
          at: new Date().toISOString(),
        };
      } catch (e) {
        if (!/nothing to commit/.test(e.stdout || "")) {
          throw e;
        }
      }
    }

    // 5. Sync with the remote, when configured.
    if (this.cfg.remote) {
      await git.run(this.vaultPath, ["remote", "set-url", "origin", this.cfg.remote]);

      // pull --rebase: never merge-commit, never force. A conflict here
      // aborts and surfaces as state=conflict (halted).
      try {
        await git.run(
          this.vaultPath,
          ["pull", "--rebase", "--autostash", "origin", this.cfg.branch],
          { timeout: git.NETWORK_TIMEOUT_MS },
        );
      } catch (e) {
        // An empty remote (branch not created yet) is not an error: the
        // first push creates it.
        if (!/couldn't find remote ref/i.test(e.stderr || "")) {
          // Try to leave a clean rebase state behind.
          await git
            .run(this.vaultPath, ["rebase", "--abort"])
            .catch(() => {});
          throw e;
        }
      }

      await this.ensureUpstream();

      if ((committed || this.pushPending) && this.cfg.autoPush) {
        try {
          await git.run(
            this.vaultPath,
            ["push", "origin", this.cfg.branch],
            { timeout: git.NETWORK_TIMEOUT_MS },
          );
          this.pushPending = false;
        } catch (e) {
          this.pushPending = true;
          throw e;
        }
      }
    } else if (committed) {
      this.pushPending = true; // commit exists but no remote configured
    }
  }
}

module.exports = { VaultSync, STATES };
