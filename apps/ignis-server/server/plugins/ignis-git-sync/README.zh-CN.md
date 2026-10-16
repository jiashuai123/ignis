# ignis-git-sync（中文版）

[English](README.md) | 简体中文

一个 [Ignis](https://github.com/Nystik-gh/ignis) 服务端插件，**自动将 vault
的变更 commit 到 git 并 push 到远端**（如 GitHub）——相当于 obsidian-git 的
服务端版本。

- 浏览器标签页打开时，watcher 事件触发**防抖**同步；每个 vault 还有**轮询
  兜底**（Ignis 的 watcher 在最后一个客户端断开约 10 分钟后会停）。
- **安全第一**：绝不 force-push、绝不产生 merge commit（只用
  `pull --rebase --autostash`）。rebase 冲突时自动暂停该 vault 的同步并报
  出状态——你的数据永远不会被覆盖。
- 默认把 `.obsidian/` 也提交，但忽略高频抖动的 UI 状态
  （`workspace.json`、`workspace.<name>.json`、`cache`），通过 vault 内
  `.gitignore` 的标记块管理。

## 前置条件

- 服务器容器里要有 `git`。官方镜像（基于 `node:22-slim`）**不带 git**——用
  附带的一行 Dockerfile 重建：

```bash
docker build -t nobbe/ignis:git -f Dockerfile.git .
# 然后把 docker-compose.yml 的 image 换成 nobbe/ignis:git
```

- 推送凭据：HTTPS remote 内嵌 PAT
  （`https://<token>@github.com/user/repo.git`），或 SSH remote + 挂载
  deploy key。

## 安装

把本目录拷到 Ignis 代码的 `apps/ignis-server/server/plugins/ignis-git-sync/`
（Docker 则挂载到容器内同路径），对 vault 启用插件后配置远端：

```bash
# 一次性，每个 vault 一条
curl -X POST https://host/api/ext/ignis-git-sync/config \
  -H 'Content-Type: application/json' \
  -d '{"vault":"My Vault","remote":"https://<token>@github.com/user/repo.git","branch":"main"}'

# 在 vault 里初始化 git + 首次同步（或用 mode:"clone" 把已有仓库拉下来当 vault）
curl -X POST https://host/api/ext/ignis-git-sync/setup \
  -H 'Content-Type: application/json' \
  -d '{"vault":"My Vault","mode":"init"}'
```

之后全自动。浏览器里的编辑、AI Agent（ignis-mcp）的写入、任何进程对 vault
目录的修改，都会在防抖窗口（默认 60 秒）内被 commit 并 push。

## 路由

| 路由 | 功能 |
|---|---|
| `GET /api/ext/ignis-git-sync/status` | 各 vault 状态：`idle / syncing / error / conflict`、最近同步、最近提交、dirty、是否暂停 |
| `POST /api/ext/ignis-git-sync/sync` `{vault, force?}` | 手动触发；`force:true` 恢复暂停的 vault |
| `GET /api/ext/ignis-git-sync/config?vault=` | 查看某 vault 的配置 |
| `POST /api/ext/ignis-git-sync/config` | 更新 `remote / branch / author / debounceMs / pollMs / autoPush / ignoreObsidianConfig / gitignoreExtras` |
| `POST /api/ext/ignis-git-sync/setup` `{vault, mode, remote?, branch?}` | `init` 初始化 vault 目录，或 `clone` 把已有仓库克隆为 vault（要求 vault 目录为空） |

状态变化同时通过 `plugin:ignis-git-sync` WebSocket 频道广播。

## 冲突处理

`pull --rebase` 遇到冲突时，插件会 abort 掉 rebase、暂停该 vault 的自动
同步，并在状态里报 `state: "conflict"` 和原因。在服务器上解决冲突（改文件
或在 vault 目录里手动 `git rebase`），然后用
`POST /sync {"vault":"...","force":true}` 恢复。

## 注意事项

- 提交粒度是每个防抖窗口一次 commit，不是每次编辑一次。
- vault 内容会进你的 git 托管平台——个人笔记建议用私有仓库。
- 没有浏览器标签页打开时，最坏检测延迟 = 轮询间隔（默认 60 秒）。
