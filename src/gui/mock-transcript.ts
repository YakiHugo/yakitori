// Dev-only preview: seeds a fabricated transcript so typography and cell
// rendering can be reviewed without a provider. Enabled via ?mock=transcript
// (main.tsx skips boot() in that mode). Not loaded in normal sessions.
import type { ApiSessionDetail } from "../server/protocol.ts"
import type { ExecutionEntry, ExecutionViewState } from "./execution-view.ts"
import { createExecutionViewState } from "./execution-view.ts"
import { useAppStore } from "./store/app-store.ts"

const SESSION_ID = "session_mock_typography"
const DAY = "2026-09-24"
const at = (time: string) => `${DAY}T${time}+08:00`

const TURN_1_ANSWER = `## 排版检查结果

对照 Codex 的排版体系，我把 \`globals.css\` 的 \`.markdown\` 重写了。**核心结论**：它是一套由 \`--md-space\`（字号 ÷ 4）推导出来的比例系统，不是一组写死的像素值。

- 正文 16px / 26px，段落间距 1em，比之前松一整倍
- 标题按比例缩放，全部 semibold，列表 marker 加粗
- 行内代码没有底色斑块，比如 \`pnpm typecheck\` 就是纯等宽字
- 嵌套列表换 marker：
  - 第二级是 circle
  - 再往下是 square

### 代码块

\`\`\`ts
const ratio = 1.625
export function lineHeight(fontSize: number): number {
  return Math.round(fontSize * ratio)
}
\`\`\`

### 引用与表格

> Codex 的引用块不是斜体，也不灰化——左侧一根圆角竖条，正文颜色保持不变。

| 项目 | Codex | Yakitori（改后） |
| --- | --- | --- |
| 正文字号 | 16px | 16px |
| 行高 | 1.625 | 1.625 |
| 行内代码 | 无底色 | 无底色 |

---

有序列表和任务列表也顺手验证：

1. typecheck 通过
2. lint 通过
3. 浏览器实测三张截图

- [x] 标题比例
- [x] 行内代码去斑块
- [ ] 工具行重构

背景和设计依据见 [Codex markdown 模块](https://example.com/codex-markdown)。`

const TURN_2_ANSWER = `失败编辑、权限记录都在上面这组里了。再看一张窄表和多段引用：

| 状态 | 含义 |
| --- | --- |
| \`failed\` | 工具返回错误，整组标红并默认展开 |
| \`resolving\` | 权限已点击，等待落盘 |

> 引用块第一段。
>
> 第二段保持同样的竖条、行距和字色。`

const READ_EXCERPT = `.markdown {
  min-width: 0;
  overflow-wrap: anywhere;
}
.markdown p,
.markdown ul,
.markdown ol,
.markdown pre {
  margin-top: 0.5rem;
  margin-bottom: 0.5rem;
}
.markdown code {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.8125em;
  background: var(--muted);
  border-radius: var(--radius-sm);
  padding: 0.1em 0.3em;
}`

const EDIT_DIFF = `--- a/src/gui/styles/globals.css
+++ b/src/gui/styles/globals.css
@@ -112,10 +112,7 @@
 .markdown code {
   font-family: var(--font-mono, ui-monospace, monospace);
-  font-size: 0.8125em;
-  background: var(--muted);
-  border-radius: var(--radius-sm);
-  padding: 0.1em 0.3em;
+  font-size: 0.875em;
 }
 .markdown pre {
   background: var(--muted);
-  border-radius: var(--radius-md);
+  border-radius: 12px;`

const REASONING_1 = `先把现在的 \`.markdown\` 规则读一遍：正文 \`text-[15px] leading-7\`、行内代码带 \`bg-muted\` 斑块、标题只有字重没有比例、表格是全边框网格——和 Codex 的 \`--markdown-space\` 比例系统差距比较大。

再看间距：Codex 段落间距 1em（16px），我们只有 0.5rem（8px），密度是它两倍。标题 h1–h4 同字号也是一个明显的减分项。`

function entries(): ExecutionEntry[] {
  return [
    {
      kind: "user_input",
      inputId: "input_1",
      text: "帮我把 markdown 排版过一遍：标题、列表、代码块、引用、表格都要看效果，顺便对照一下 Codex 的风格。",
      at: at("11:00:00"),
    },
    {
      kind: "reasoning",
      itemId: "item_reason_1",
      turnId: "turn_1",
      text: REASONING_1,
      status: "completed",
      at: at("11:00:04"),
    },
    {
      kind: "assistant",
      itemId: "item_msg_1",
      turnId: "turn_1",
      text: "我先读当前的样式实现，再对照 Codex 的排版体系逐项改。",
      status: "completed",
      at: at("11:00:06"),
    },
    {
      kind: "tool",
      toolCallId: "call_read",
      turnId: "turn_1",
      state: "completed",
      execution: {
        type: "file_read",
        itemId: "item_read",
        toolCallId: "call_read",
        name: "read_file",
        input: { path: "src/gui/styles/globals.css", offset: 86, limit: 20 },
        requiresPermission: false,
        path: "src/gui/styles/globals.css",
        offset: 86,
        limit: 20,
        result: {
          path: "src/gui/styles/globals.css",
          kind: "file",
          range: { offset: 86, limit: 20 },
          empty: false,
          truncated: false,
        },
      },
      resultText: READ_EXCERPT,
    },
    {
      kind: "tool",
      toolCallId: "call_run",
      turnId: "turn_1",
      state: "completed",
      execution: {
        type: "command_execution",
        itemId: "item_run",
        toolCallId: "call_run",
        name: "exec_command",
        input: { cmd: "pnpm typecheck" },
        requiresPermission: false,
        command: "pnpm typecheck",
        result: {
          exitCode: 0,
          signal: null,
          stdout: "$ tsc --noEmit\n",
          stderr: "",
          truncated: false,
          timedOut: false,
          durationMs: 5214,
          cwd: "/Users/hugo/Documents/yakitori",
          shell: "zsh",
        },
      },
      resultText: "$ tsc --noEmit\n",
    },
    {
      kind: "tool",
      toolCallId: "call_edit",
      turnId: "turn_1",
      state: "completed",
      execution: {
        type: "file_change",
        itemId: "item_edit",
        toolCallId: "call_edit",
        name: "edit_file",
        input: {
          path: "src/gui/styles/globals.css",
          oldString: "font-size: 0.8125em;",
          newString: "font-size: 0.875em;",
        },
        requiresPermission: false,
        request: { operation: "edit", paths: ["src/gui/styles/globals.css"] },
        changes: [
          {
            kind: "update",
            path: "src/gui/styles/globals.css",
            diff: { format: "unified", text: EDIT_DIFF, truncated: false },
          },
        ],
      },
    },
    {
      kind: "tool",
      toolCallId: "call_search",
      turnId: "turn_1",
      state: "completed",
      execution: {
        type: "web_search",
        itemId: "item_search",
        toolCallId: "call_search",
        name: "web_search",
        input: { query: "codex markdown typography" },
        requiresPermission: false,
        query: "codex markdown typography",
        result: {
          links: [
            {
              title: "Codex GUI markdown module",
              url: "https://example.com/codex-markdown",
            },
            {
              title: "OpenAI Sans typeface",
              url: "https://example.com/openai-sans",
            },
          ],
        },
      },
      resultText: "2 results",
    },
    {
      kind: "assistant",
      itemId: "item_final_1",
      turnId: "turn_1",
      text: TURN_1_ANSWER,
      status: "completed",
      at: at("11:03:24"),
    },
    {
      kind: "user_input",
      inputId: "input_2",
      text: "表格、引用块、任务列表也看看，再给一个编辑失败的样子。",
      at: at("11:04:00"),
    },
    {
      kind: "assistant",
      itemId: "item_msg_2",
      turnId: "turn_2",
      text: "好——这轮带上失败编辑、一条权限记录和一组测试结果。",
      status: "completed",
      at: at("11:04:03"),
    },
    {
      kind: "tool",
      toolCallId: "call_edit_2",
      turnId: "turn_2",
      state: "failed",
      resultError: true,
      resultErrorMessage:
        "old_string_ambiguous: oldString matched 2 locations in test/gui/composer.test.tsx. Exact match locations: lines 414–414, 529–529.",
      execution: {
        type: "file_change",
        itemId: "item_edit_2",
        toolCallId: "call_edit_2",
        name: "edit_file",
        input: {
          path: "test/gui/composer.test.tsx",
          oldString: "expect(send).toBeDefined()",
          newString: "expect(send).toHaveBeenCalledOnce()",
        },
        requiresPermission: false,
        request: { operation: "edit", paths: ["test/gui/composer.test.tsx"] },
        changes: [],
      },
      resultText:
        "old_string_ambiguous: oldString matched 2 locations in test/gui/composer.test.tsx. Exact match locations: lines 414–414, 529–529.",
    },
    {
      kind: "permission",
      permissionRequestId: "perm_1",
      turnId: "turn_2",
      toolCallId: "call_run_2",
      action: "run_command",
      subject: "pnpm test",
      state: "resolved",
      behavior: "allow",
    },
    {
      kind: "tool",
      toolCallId: "call_run_2",
      turnId: "turn_2",
      state: "completed",
      execution: {
        type: "command_execution",
        itemId: "item_run_2",
        toolCallId: "call_run_2",
        name: "exec_command",
        input: { cmd: "pnpm test" },
        requiresPermission: true,
        command: "pnpm test",
        result: {
          exitCode: 0,
          signal: null,
          stdout:
            " Test Files  164 passed (164)\n      Tests  1823 passed (1823)\n   Duration  19.27s",
          stderr: "",
          truncated: false,
          timedOut: false,
          durationMs: 19273,
          cwd: "/Users/hugo/Documents/yakitori",
          shell: "zsh",
        },
      },
      resultText:
        " Test Files  164 passed (164)\n      Tests  1823 passed (1823)\n   Duration  19.27s",
    },
    {
      kind: "assistant",
      itemId: "item_final_2",
      turnId: "turn_2",
      text: TURN_2_ANSWER,
      status: "completed",
      at: at("11:05:49"),
    },
    {
      kind: "user_input",
      inputId: "input_3",
      text: "最后看看被打断的 turn 长什么样。",
      at: at("11:06:00"),
    },
    {
      kind: "assistant",
      itemId: "item_msg_3",
      turnId: "turn_3",
      text: "这一轮说到一半就被打断了——",
      status: "completed",
      at: at("11:06:12"),
    },
    {
      kind: "turn_terminal",
      turnId: "turn_3",
      state: "interrupted",
      message: "Turn interrupted.",
    },
  ]
}

function buildExecution(): ExecutionViewState {
  const all = entries()
  const itemEntryIndexes: Record<string, number> = {}
  const permissionEntryIndexes: Record<string, number> = {}
  all.forEach((entry, index) => {
    if (
      entry.kind === "assistant" ||
      entry.kind === "reasoning" ||
      entry.kind === "tool"
    ) {
      itemEntryIndexes[entry.kind === "tool" ? entry.execution.itemId : entry.itemId] =
        index
    } else if (entry.kind === "permission") {
      permissionEntryIndexes[entry.permissionRequestId] = index
    }
  })
  return {
    ...createExecutionViewState(),
    entries: all,
    itemEntryIndexes,
    permissionEntryIndexes,
    workingDirectory: "/Users/hugo/Documents/yakitori",
    lastSeq: 42,
    turnTimings: {
      turn_1: { inputId: "input_1", startedAt: at("11:00:02"), completedAt: at("11:03:24") },
      turn_2: { inputId: "input_2", startedAt: at("11:04:02"), completedAt: at("11:05:49") },
      turn_3: { inputId: "input_3", startedAt: at("11:06:02"), completedAt: at("11:06:40") },
    },
    telemetry: {
      turns: 3,
      steps: 14,
      modelDurationMs: 204_000,
      toolDurationMs: 38_000,
      inputTokens: 812_004,
      outputTokens: 24_610,
      cacheReadInputTokens: 790_112,
      cacheWriteInputTokens: 12_380,
    },
  }
}

export function seedMockTranscript(): void {
  const session: ApiSessionDetail = {
    id: SESSION_ID,
    conversationId: SESSION_ID,
    seq: 42,
    createdAt: at("11:00:00"),
    updatedAt: at("11:06:40"),
    title: "Mock · 排版预览",
    workingDirectory: "/Users/hugo/Documents/yakitori",
    pendingInputs: [],
    pendingPermissions: [],
    counts: {
      inputs: 3,
      pendingInputs: 0,
      turns: 3,
      items: 11,
      permissions: 1,
      tools: 6,
    },
  }
  useAppStore.setState({
    selection: { sessionId: SESSION_ID },
    selectedSession: session,
    execution: buildExecution(),
  })
}
