"use strict";

const fs = require("fs");
const path = require("path");
const git = require("./git");
const configStore = require("./config-store");
const { VaultSync, STATES } = require("./sync-manager");

class SyncManager {
  constructor(ctx) {
    this._ctx = ctx;
    this._vaults = new Map(); // vaultId -> VaultSync
    this._channel = null;

    try {
      this._channel = ctx.wss.channel("plugin:ignis-git-sync");
    } catch {
      // wss optional in tests
    }
  }

  _onState(snapshot) {
    if (!this._channel) {
      return;
    }

    this._channel.broadcastToVault(snapshot.vaultId, {
      type: "git-sync-status",
      payload: snapshot,
    });
  }

  _resolveVaultPath(vaultId) {
    const id = vaultId || this._ctx.config.defaultVaultId;
    const vaultPath = this._ctx.config.getVaultPath(id);

    if (!vaultPath) {
      return null;
    }

    if (!this._ctx.getEnabledVaults().includes(id)) {
      return null;
    }

    return { id, path: vaultPath };
  }

  async addVault(vaultId) {
    if (this._vaults.has(vaultId)) {
      return this._vaults.get(vaultId);
    }

    const vaultPath = this._ctx.config.getVaultPath(vaultId);

    if (!vaultPath) {
      return null;
    }

    const cfg = await configStore.getForVault(this._ctx.dataDir, vaultId);
    const vs = new VaultSync(vaultId, vaultPath, cfg, {
      onState: (s) => this._onState(s),
    });

    this._vaults.set(vaultId, vs);
    vs.start();

    return vs;
  }

  removeVault(vaultId) {
    const vs = this._vaults.get(vaultId);

    if (vs) {
      vs.stop();
      this._vaults.delete(vaultId);
    }
  }

  get(vaultId) {
    return this._vaults.get(vaultId) || null;
  }

  async watchVaultEvent(vaultId, event) {
    if (!this._vaults.has(vaultId)) {
      return;
    }

    this._vaults.get(vaultId).onVaultEvent(event);
  }

  status() {
    return [...this._vaults.values()].map((vs) => vs.snapshot());
  }

  async syncVault(vaultId, force) {
    const resolved = this._resolveVaultPath(vaultId);

    if (!resolved) {
      const err = new Error("Vault not found or plugin not enabled for it");
      err.code = "VAULT_NOT_ALLOWED";
      throw err;
    }

    let vs = this._vaults.get(resolved.id);

    if (!vs) {
      vs = await this.addVault(resolved.id);
    }

    return vs.syncNow(force);
  }

  async getVaultConfig(vaultId) {
    const resolved = this._resolveVaultPath(vaultId);

    if (!resolved) {
      const err = new Error("Vault not found or plugin not enabled for it");
      err.code = "VAULT_NOT_ALLOWED";
      throw err;
    }

    return configStore.getForVault(this._ctx.dataDir, resolved.id);
  }

  async setVaultConfig(vaultId, patch) {
    const resolved = this._resolveVaultPath(vaultId);

    if (!resolved) {
      const err = new Error("Vault not found or plugin not enabled for it");
      err.code = "VAULT_NOT_ALLOWED";
      throw err;
    }

    const allowed = [
      "remote",
      "branch",
      "author",
      "debounceMs",
      "pollMs",
      "autoPush",
      "ignoreObsidianConfig",
      "gitignoreExtras",
    ];
    const clean = {};

    for (const key of allowed) {
      if (patch[key] !== undefined) {
        clean[key] = patch[key];
      }
    }

    if (clean.remote !== undefined && typeof clean.remote !== "string") {
      const err = new Error("remote must be a string");
      err.code = "BAD_ARGS";
      throw err;
    }

    if (clean.branch !== undefined && !/^[^\s~^:?*[\\]+$/.test(clean.branch)) {
      const err = new Error("invalid branch name");
      err.code = "BAD_ARGS";
      throw err;
    }

    const cfg = await configStore.setForVault(this._ctx.dataDir, resolved.id, clean);

    const vs = this._vaults.get(resolved.id);

    if (vs) {
      vs.updateConfig(cfg);
    }

    return cfg;
  }

  /**
   * mode "init": initialize git in the existing vault dir.
   * mode "clone": requires an EMPTY vault dir; clones remote into it.
   */
  async setupVault(vaultId, { mode = "init", remote, branch } = {}) {
    const resolved = this._resolveVaultPath(vaultId);

    if (!resolved) {
      const err = new Error("Vault not found or plugin not enabled for it");
      err.code = "VAULT_NOT_ALLOWED";
      throw err;
    }

    if (!remote && mode === "clone") {
      const err = new Error("remote is required for clone");
      err.code = "BAD_ARGS";
      throw err;
    }

    if (remote) {
      await this.setVaultConfig(resolved.id, { remote });
    }

    if (branch) {
      await this.setVaultConfig(resolved.id, { branch });
    }

    const vs =
      this._vaults.get(resolved.id) || (await this.addVault(resolved.id));

    if (mode === "clone") {
      const entries = await fs.promises.readdir(resolved.path);
      const visible = entries.filter((e) => !e.startsWith("."));

      if (visible.length > 0) {
        const err = new Error("clone requires an empty vault directory");
        err.code = "VAULT_NOT_EMPTY";
        throw err;
      }

      const parent = path.dirname(resolved.path);
      const name = path.basename(resolved.path);

      // clone into a temp dir then move contents (vault dir already exists)
      const tmp = path.join(parent, `.${name}.gitclone-${Date.now()}`);
      await git.run(parent, ["clone", "--branch", branch || vs.cfg.branch, remote, tmp], {
        timeout: git.NETWORK_TIMEOUT_MS,
      });

      // move everything except .git into the vault, then .git last
      for (const entry of await fs.promises.readdir(tmp)) {
        await fs.promises.rename(path.join(tmp, entry), path.join(resolved.path, entry));
      }

      await fs.promises.rm(tmp, { recursive: true, force: true });
    }

    await vs.syncNow(true);

    return vs.snapshot();
  }

  async shutdown() {
    for (const [id] of this._vaults) {
      this.removeVault(id);
    }
  }
}

module.exports = { SyncManager, STATES };
