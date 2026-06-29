# Yakitori

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh-CN.md">简体中文</a>
</p>

Yakitori 是一个从零开始实现 coding-agent harness 和 GUI 的学习项目。目标是通过一个模块一个模块地实现，理解现代 coding-agent 产品背后的 runtime、事件、工具、权限、持久化和回放机制。

本项目会参考 opencode、Codex 公开源码、Claude Code 的公开文档和可观察行为，以及一个非官方 Claude Code sourcemap 还原仓库用于研究，但不会包装或依赖现成 agent 框架。

## 目标

- 从第一性原理构建一个本地 coding-agent harness。
- 让 harness core 负责 sessions、turns、events、tools、permissions、persistence 和 replay。
- 构建一个可以观察 harness 运行过程的 GUI。
- 用结构化状态支持 debugging、replay 和 evaluation。
- 保持模块足够小，方便理解、替换和迭代。

## 非目标

- 不使用 LangGraph、AutoGen、OpenAI Agents SDK、Claude Agent SDK 或类似 agent orchestration 框架。
- 不让运行时代码依赖本地参考仓库。
- 不完整复刻任何产品行为；参考项目只用于比较和学习。

## 参考材料

本地参考材料可以放在 `.references/` 下，该目录会被 git 忽略。目前计划参考：

- `opencode`
- `openai/codex`
- `ChinaSiro/claude-code-sourcemap`，作为非官方 sourcemap 还原参考，仅用于研究
- Claude Code 的公开文档和可观察行为

参考材料不是项目源码的一部分，构建、测试或运行 Yakitori 都不应该依赖它们。

## 当前状态

项目目前处于 bootstrap 阶段。初始工具链使用 Node、pnpm、Vite、Vitest、TypeScript 和 Biome。server shape、GUI stack 和 runtime modules 仍然保持开放。

第一个实现模块应该尽量小，并且可以在本地跑起来。比较适合的起点是 session/event kernel：

- 创建 session
- 追加 turn
- 写入结构化 events
- 读取 event log
- 暴露未来 GUI 所需的最小状态

## 可能结构

项目后续可能围绕这些模块生长：

```text
core        session, turn, item, event, replay primitives
runtime     agent loop, model adapter boundary, tool execution
tools       built-in permission-checked tools
storage     event log and persisted state
server      local API used by the GUI
gui         workbench for sessions, turns, events, and tool calls
evals       scenarios and replay-based checks
```

这只是方向，不是已经承诺的目录结构。第一个模块落地后再更新这里。

## 开发

安装依赖：

```sh
pnpm install
```

运行完整本地检查：

```sh
pnpm check
```

常用单项命令：

```sh
pnpm typecheck
pnpm test
pnpm lint
pnpm format
pnpm dev
pnpm build
```

## Agent 维护规则

查看 `AGENTS.md` 了解仓库维护规则、代码风格、参考边界和测试预期。
