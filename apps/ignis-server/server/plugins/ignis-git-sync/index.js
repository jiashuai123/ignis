"use strict";

/**
 * ignis-git-sync — Ignis server plugin that automatically commits vault
 * changes to git and pushes to a remote (e.g. GitHub).
 *
 * The server-side equivalent of obsidian-git: the vault lives on the server,
 * so this runs next to it with real git. Watcher events accelerate syncing
 * when browser tabs are open; a per-vault poll interval is the fallback and
 * covers headless periods (Ignis watchers stop ~10 min after the last
 * client disconnects).
 *
 * Safety rules:
 *   - never force-push, never merge-commit (pull --rebase --autostash only)
 *   - on rebase conflict: halt auto-sync for that vault, surface status,
 *     wait for a human (manual /sync with force resumes)
 *   - .obsidian/ is committed by default except volatile UI state
 *     (workspace.json etc.), managed via a marked .gitignore block
 */

const git = require("./git");
const { SyncManager } = require("./manager");
const configStore = require("./config-store");

module.exports = {
  id: "ignis-git-sync",
  name: "Git Sync",
  description:
    "Automatically commit vault changes to git and push to a remote repository",
  version: "0.1.0",

  _ctx: null,
  _manager: null,
  _onWatcherEvent: null,

  async register(ctx) {
    this._ctx = ctx;

    const gitVersion = await git.available();

    if (!gitVersion) {
      ctx.log(
        "git NOT FOUND — install git in the container (see Dockerfile.git) or the plugin cannot sync",
      );
    } else {
      ctx.log(`git available: ${gitVersion}`);
    }

    // Poll fallback default (tests override with GIT_SYNC_POLL_MS).
    if (process.env.GIT_SYNC_POLL_MS) {
      const ms = Number(process.env.GIT_SYNC_POLL_MS);

      if (Number.isFinite(ms) && ms > 0) {
        configStore.DEFAULTS.pollMs = ms;
        ctx.log(`poll interval overridden to ${ms}ms`);
      }
    }

    this._manager = new SyncManager(ctx);

    for (const vaultId of ctx.getEnabledVaults()) {
      await this._manager.addVault(vaultId);
    }

    ctx.log(
      `registered (vaults: ${ctx.getEnabledVaults().join(", ") || "none"})`,
    );

    // Accelerator: vault watcher events (only fire while a client is
    // connected) trigger a debounced sync.
    this._onWatcherEvent = (vaultId, event) => {
      this._manager?.watchVaultEvent(vaultId, event);
    };

    try {
      ctx.watcher.addGlobalListener(this._onWatcherEvent);
    } catch (e) {
      ctx.log(`watcher not available: ${e.message}`);
    }

    const { mountRoutes } = require("./routes");
    mountRoutes(ctx.router, this);
  },

  getCtx() {
    return this._ctx;
  },

  getManager() {
    return this._manager;
  },

  async shutdown() {
    if (this._ctx && this._onWatcherEvent) {
      try {
        this._ctx.watcher.removeGlobalListener(this._onWatcherEvent);
      } catch {
        // watcher already torn down
      }
    }

    this._onWatcherEvent = null;

    if (this._manager) {
      await this._manager.shutdown();
      this._manager = null;
    }

    this._ctx = null;
  },

  async onVaultEnabled(vaultId) {
    if (this._ctx) {
      this._ctx.log(`vault enabled: ${vaultId}`);
      await this._manager?.addVault(vaultId);
    }
  },

  async onVaultDisabled(vaultId) {
    if (this._ctx) {
      this._ctx.log(`vault disabled: ${vaultId}`);
      this._manager?.removeVault(vaultId);
    }
  },
};
