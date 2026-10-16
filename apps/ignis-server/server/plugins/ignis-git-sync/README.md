# ignis-git-sync

English | [简体中文](README.zh-CN.md)

An [Ignis](https://github.com/Nystik-gh/ignis) server plugin that
**automatically commits vault changes to git and pushes to a remote**
(e.g. GitHub) — the server-side equivalent of obsidian-git.

- Watcher events (browser tabs open) trigger a **debounced** sync; a
  per-vault **poll interval** covers headless periods (Ignis watchers stop
  ~10 min after the last client disconnects).
- **Safety first**: never force-push, never merge-commit
  (`pull --rebase --autostash` only). On a rebase conflict, auto-sync halts
  for that vault and the status endpoint tells you — your data is never
  overwritten.
- `.obsidian/` is committed by default, except volatile UI state
  (`workspace.json`, `workspace.<name>.json`, `cache`), managed through a
  marked block in the vault's `.gitignore`.

## Requirements

- `git` in the server container. The stock image (`node:22-slim` based)
  does **not** include git — rebuild with the bundled one-liner:

```bash
docker build -t nobbe/ignis:git -f Dockerfile.git .
# then switch docker-compose.yml to image: nobbe/ignis:git
```

- Push credentials: HTTPS remote with an embedded PAT
  (`https://<token>@github.com/user/repo.git`) or an SSH remote with a
  mounted deploy key.

## Install

Copy this folder to `apps/ignis-server/server/plugins/ignis-git-sync/` in
your Ignis checkout (mount into the container at the same path) and enable
the plugin for a vault. Then configure a remote:

```bash
# one-time, per vault
curl -X POST https://host/api/ext/ignis-git-sync/config \
  -H 'Content-Type: application/json' \
  -d '{"vault":"My Vault","remote":"https://<token>@github.com/user/repo.git","branch":"main"}'

# initialize git in the vault + first sync (or mode:"clone" to pull an
# existing repo down as the vault)
curl -X POST https://host/api/ext/ignis-git-sync/setup \
  -H 'Content-Type: application/json' \
  -d '{"vault":"My Vault","mode":"init"}'
```

After that it runs by itself. Edits from browser tabs, AI agents
(ignis-mcp), or any process writing to the vault directory get committed
within the debounce window (default 60 s) and pushed.

## Routes

| Route | What it does |
|---|---|
| `GET /api/ext/ignis-git-sync/status` | Per-vault state: `idle / syncing / error / conflict`, last sync, last commit, dirty, halted |
| `POST /api/ext/ignis-git-sync/sync` `{vault, force?}` | Manual trigger; `force:true` resumes a halted vault |
| `GET /api/ext/ignis-git-sync/config?vault=` | Current config for a vault |
| `POST /api/ext/ignis-git-sync/config` | Update `remote / branch / author / debounceMs / pollMs / autoPush / ignoreObsidianConfig / gitignoreExtras` |
| `POST /api/ext/ignis-git-sync/setup` `{vault, mode, remote?, branch?}` | `init` the vault dir, or `clone` an existing repo as the vault (vault dir must be empty) |

Status changes are also broadcast on the `plugin:ignis-git-sync` WebSocket
channel.

## Conflict handling

When `pull --rebase` hits a conflict, the plugin aborts the rebase, halts
auto-sync for that vault, and reports `state: "conflict"` with the reason.
Fix it on the server (edit files / `git rebase` in the vault dir), then
resume with `POST /sync {"vault":"...","force":true}`.

## Caveats

- Commit history is one commit per debounce window, not per edit.
- Vault contents go to your git host — pick the remote accordingly
  (private repo for personal notes).
- The poll interval (default 60 s) is the worst-case detection latency for
  changes made while no browser tab is open.
