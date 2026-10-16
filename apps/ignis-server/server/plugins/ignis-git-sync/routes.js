"use strict";

const { sanitizeError } = require("@ignis/server-core");

function mountRoutes(router, plugin) {
  const mgr = () => plugin.getManager();
  const ctx = () => plugin.getCtx();

  // GET /api/ext/ignis-git-sync/status
  router.get("/status", (req, res) => {
    if (!ctx()) {
      return res.status(503).json({ error: "Plugin not registered" });
    }

    res.json({
      ok: true,
      vaults: mgr().status(),
    });
  });

  // POST /api/ext/ignis-git-sync/sync { vault, force? }
  router.post("/sync", async (req, res) => {
    try {
      const snapshot = await mgr().syncVault(
        req.body?.vault,
        req.body?.force === true,
      );
      res.json({ ok: true, vault: snapshot });
    } catch (e) {
      res
        .status(e.code === "VAULT_NOT_ALLOWED" ? 403 : 500)
        .json(e.code ? { error: e.message, code: e.code } : sanitizeError(e));
    }
  });

  // GET /api/ext/ignis-git-sync/config?vault=<id>
  router.get("/config", async (req, res) => {
    try {
      const cfg = await mgr().getVaultConfig(req.query.vault);
      res.json(cfg);
    } catch (e) {
      res
        .status(e.code === "VAULT_NOT_ALLOWED" ? 403 : 500)
        .json(e.code ? { error: e.message, code: e.code } : sanitizeError(e));
    }
  });

  // POST /api/ext/ignis-git-sync/config { vault, remote?, branch?, author?, ... }
  router.post("/config", async (req, res) => {
    try {
      const cfg = await mgr().setVaultConfig(req.body?.vault, req.body || {});
      res.json({ ok: true, config: cfg });
    } catch (e) {
      res
        .status(e.code === "VAULT_NOT_ALLOWED" || e.code === "BAD_ARGS" ? 400 : 500)
        .json(e.code ? { error: e.message, code: e.code } : sanitizeError(e));
    }
  });

  // POST /api/ext/ignis-git-sync/setup { vault, mode: "init"|"clone", remote?, branch? }
  router.post("/setup", async (req, res) => {
    try {
      const snapshot = await mgr().setupVault(req.body?.vault, req.body || {});
      res.json({ ok: true, vault: snapshot });
    } catch (e) {
      const code =
        e.code === "VAULT_NOT_ALLOWED" || e.code === "BAD_ARGS" || e.code === "VAULT_NOT_EMPTY"
          ? 400
          : 500;
      res
        .status(code)
        .json(e.code ? { error: e.message, code: e.code } : sanitizeError(e));
    }
  });
}

module.exports = { mountRoutes };
