"use strict";

const fs = require("fs");
const path = require("path");

const CONFIG_FILE = "vault-config.json";

const DEFAULTS = {
  remote: "",
  branch: "main",
  author: {
    name: "Ignis Git Sync",
    email: "git-sync@ignis.local",
  },
  debounceMs: 60 * 1000, // watcher-event debounce window
  pollMs: 60 * 1000, // fallback dirty-check interval
  autoPush: true,
  ignoreObsidianConfig: false, // false = commit .obsidian/ except volatile state
  gitignoreExtras: [], // extra .gitignore lines
};

const MANAGED_IGNORE_MARKER = "# --- ignis-git-sync managed (do not edit below) ---";
const BASE_IGNORE_PATTERNS = [
  ".obsidian/workspace.json",
  ".obsidian/workspace.*.json",
  ".obsidian/cache",
  ".trash/",
];

function configFile(dataDir) {
  return path.join(dataDir, CONFIG_FILE);
}

async function load(dataDir) {
  try {
    const raw = JSON.parse(await fs.promises.readFile(configFile(dataDir), "utf-8"));
    // shallow-merge per-vault over defaults
    const out = {};
    for (const [vaultId, cfg] of Object.entries(raw)) {
      out[vaultId] = { ...DEFAULTS, ...cfg, author: { ...DEFAULTS.author, ...cfg.author } };
    }
    return out;
  } catch {
    return {};
  }
}

async function save(dataDir, config) {
  await fs.promises.mkdir(dataDir, { recursive: true });
  await fs.promises.writeFile(configFile(dataDir), JSON.stringify(config, null, 2));
}

async function getForVault(dataDir, vaultId) {
  const all = await load(dataDir);
  return all[vaultId] || { ...DEFAULTS, author: { ...DEFAULTS.author } };
}

async function setForVault(dataDir, vaultId, patch) {
  const all = await load(dataDir);
  const current = all[vaultId] || { ...DEFAULTS, author: { ...DEFAULTS.author } };
  const next = { ...current, ...patch };

  if (patch.author) {
    next.author = { ...current.author, ...patch.author };
  }

  all[vaultId] = next;
  await save(dataDir, all);
  return next;
}

function managedGitignoreLines(cfg) {
  const patterns = [...BASE_IGNORE_PATTERNS];

  if (cfg.ignoreObsidianConfig) {
    // whole .obsidian/ untracked
    patterns.unshift(".obsidian/");
  }

  for (const line of cfg.gitignoreExtras || []) {
    if (typeof line === "string" && line.trim()) {
      patterns.push(line.trim());
    }
  }

  return [MANAGED_IGNORE_MARKER, ...patterns];
}

/**
 * Ensure the vault's .gitignore contains the managed block. Preserves any
 * user content above the marker; rewrites only the managed section.
 */
async function ensureGitignore(vaultPath, cfg) {
  const gitignorePath = path.join(vaultPath, ".gitignore");
  let existing = "";

  try {
    existing = await fs.promises.readFile(gitignorePath, "utf-8");
  } catch {
    // none yet
  }

  const markerIdx = existing.indexOf(MANAGED_IGNORE_MARKER);

  if (markerIdx === -1) {
    const head = existing.trim();
    const next = `${head ? head + "\n\n" : ""}${managedGitignoreLines(cfg).join("\n")}\n`;

    await fs.promises.writeFile(gitignorePath, next);
    return;
  }

  // Marker present: keep user content above it, regenerate the managed block.
  const head = existing.slice(0, markerIdx).trim();
  const next = `${head ? head + "\n\n" : ""}${managedGitignoreLines(cfg).join("\n")}\n`;

  await fs.promises.writeFile(gitignorePath, next);
}

module.exports = {
  DEFAULTS,
  load,
  save,
  getForVault,
  setForVault,
  ensureGitignore,
  configFile,
};
