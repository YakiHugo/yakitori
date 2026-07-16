# Yakitori

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh-CN.md">简体中文</a>
</p>

Yakitori 是一个从零开始实现本地 coding-agent harness 和 GUI 的学习项目。产品方向是以具有持久记忆的 `Mate` 为核心的 coding 工作台：Mate 可以独立工作，也可以在共享任务 Room 中协作。

目标是通过一个个可审查的小模块，直接实现并理解现代 coding agent 背后的 runtime 和产品边界。Yakitori 会学习公开参考项目，但不会包装或依赖现成 agent 框架。

## 目标

- 从第一性原理构建一个本地 coding-agent harness。
- 让每个 Mate 在跨任务过程中保持持久身份、版本化 profile、受治理的记忆和可检查的历史。
- 允许多个 Mate 并行处理同一个 Task，在同一个 Room 发布发现，并通过结构化 mention 请求别人关注。
- 区分共享 Message、每个接收者的 Delivery 和每个 Mate 私有的 execution Session。
- 让 core 负责结构化执行、协作、工具、权限、持久化、恢复和回放。
- 构建一个 Task 工作台 GUI，展示共享讨论、Mate 活动、terminal、diff、审批、artifact、worktree 和记忆来源。
- 用结构化状态支持 debugging、replay 和 evaluation。
- 保持模块足够小，方便理解、替换和迭代。

## 产品方向

目标形态是：

```text
Codex 风格的 coding Task 工作台
+ 持久 Mate 和受治理的记忆
+ 共享 Room 协作和结构化 @mention
+ 每个 Mate Assignment 一条可检查的执行 lane
```

Room 并不是对 Slack 或 Raft 完整产品形态的复制，而是 coding 工作台内部的共享沟通边界。一条 Room Message 只保存一次；持久化 Delivery 决定哪些 Mate 应该稍后补读、立即唤醒或在安全边界 steer。详细工具输出保留在各自的 execution Session 中，除非 Mate 主动发布有界的发现或 artifact 引用。

## 非目标

- 不使用 LangGraph、AutoGen、OpenAI Agents SDK、Claude Agent SDK 或类似 agent orchestration 框架。
- 不让运行时代码依赖本地参考仓库。
- 不完整复刻任何产品行为；参考项目只用于比较和学习。
- 不把 Mate 当作永远运行的进程，也不把每条 transcript 消息静默提升为长期记忆。
- 不把 GUI 做成通用的频道聊天产品或任务看板。

## 参考材料

本地参考材料可以放在 `.references/` 下，该目录会被 git 忽略。目前计划参考：

- `.references/public/codex`，作为主要的工作台和系统参考
- `.references/public/opencode-v2`，参考 durable input、事务和恢复机制
- `.references/public/opencode`，仅用于 legacy v1 对照
- `.references/public/pi`，参考小型 model loop 和 provider/tool 边界
- `.references/public/claude-code-sourcemap`，作为非官方研究辅助材料
- Claude Code 的公开文档和可观察行为，交叉参考权限、hooks、instructions 和 terminal 产品行为
- Raft 的公开文档和可观察行为，参考“持久同事”和协作这一产品承诺，而不是完整照搬其产品形态

参考材料不是项目源码的一部分，构建、测试或运行 Yakitori 都不应该依赖它们。

## 当前状态

当前实现已经包括：

- 可回放的 Session/Input/Turn/Item event kernel
- 结构化的 tool 和 permission 生命周期事实
- 支持有序 append 和幂等操作的 SQLite event store
- 本地 HTTP/SSE API 边界
- 初步的 GUI session workspace

Session kernel 现在被限定为单个 Mate 的执行 lane。持久 Mate 身份、Room/Task/Assignment 协作、durable Message delivery、model/tool runtime 和受治理的记忆已经是确定的架构方向，但尚未实现。

## 可能结构

项目后续会围绕这些概念边界生长：

```text
mates      identity, immutable profiles, capabilities, memory policy
collaboration  rooms, tasks, assignments, messages, deliveries, mentions
execution      sessions, inputs, turns, items, context, replay
runtime        model loop, scheduling, pending/steer, tool execution
memory         scoped revisions, provenance, retrieval, consolidation
tools          permission-checked built-in and extension capabilities
storage        journals, projections, artifacts, checkpoints
server         versioned local command, query, and subscription APIs
gui            task room and inspectable Mate execution lanes
evals          replay, recovery, collaboration, and memory scenarios
```

这些是领域边界，不是已经承诺的目录结构，也不要求现在就把应用拆成多个服务。

## 架构文档

- [当前架构方向](docs/architecture.md)
- [最初的 Session/Turn/Item 执行核心](docs/decisions/0001-core-shape.md)
- [Kernel v1 边界](docs/decisions/0002-kernel-prelude.md)
- [本地 Server API 边界](docs/decisions/0003-server-api-boundary.md)
- [持久 Mate 和 Room 协作](docs/decisions/0004-mate-room-collaboration.md)
- [事务型 SQLite 事件存储](docs/decisions/0005-sqlite-event-store.md)

## 开发

安装依赖：

```sh
pnpm install
```

运行完整本地检查：

```sh
pnpm check
```

同时运行本地 server 和 GUI：

```sh
pnpm dev
```

打开 `http://127.0.0.1:5173`。Vite 会把本地 Session API 和 event stream
代理到 `4141` 端口的 server。只需要单独一侧时可以使用 `pnpm dev:gui` 或
`pnpm dev:server`。

常用单项命令：

```sh
pnpm typecheck
pnpm test
pnpm lint
pnpm format
pnpm build
```

构建会保留 `dist/index.js` 的 library 入口，并把 GUI 写入 `dist/gui`。

## Agent 维护规则

查看 `AGENTS.md` 了解仓库维护规则、代码风格、参考边界和测试预期。
