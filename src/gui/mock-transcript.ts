// Dev-only preview: seeds a fabricated transcript so typography and cell
// rendering can be reviewed without a provider. Enabled via ?mock=transcript
// (main.tsx skips boot() in that mode). Not loaded in normal sessions.
import type { ApiSessionDetail } from "../protocol/application.ts"
import type { ExecutionEntry, ExecutionViewState } from "./execution-view.ts"
import { createExecutionViewState } from "./execution-view.ts"
import { draftFromEditorParts, textInputDraft } from "./input-draft.ts"
import { useAppStore } from "./store/app-store.ts"

const SESSION_ID = "session_mock_typography"
const DAY = "2026-09-24"
const at = (time: string) => `${DAY}T${time}+08:00`

const TURN_1_ANSWER = `# 排版预览 · Typography

这是一段用于观察中英文混排的示例内容。正文使用系统字体，默认字号 14px、行高 22.75px；**强调文字使用 semibold**，保持与上下文相同的字号。

A reading column should make paragraphs, headings, and code easy to scan. 这段文字也可以用来检查标点、数字 0123456789，以及 \`font-family\` 等行内代码的显示。

## 列表与层级

- 正文行高比例为 1.625
- 用户消息气泡最多占阅读栏的 70%
- 嵌套列表的层级示例：
  - 第二级使用空心圆
    - 第三级使用方形

### 代码示例

\`\`\`ts
const ratio = 1.625
export function lineHeight(fontSize: number): number {
  return fontSize * ratio
}
\`\`\`

## 引用与表格

> 引用内容可以包含 **强调文字** 和 \`inline code\`。
>
> A second paragraph shows the spacing within a quotation.

| 元素 | 样例 |
| --- | --- |
| 正文 Body | 14px / 22.75px |
| 字体 Font | 系统字体 / System font |
| 强调 Emphasis | **Semibold** |
| 行内代码 Inline code | \`pnpm typecheck\` |

---

### 阅读顺序与任务列表

1. 阅读说明与示例
2. 比较宽屏和窄屏布局
3. 查看浅色与深色主题

- [x] 准备示例文字
- [ ] 检查标题与段落间距
- [ ] 检查长文本换行

此页面是开发用的静态样例；列表状态与工具输出用于展示，不代表实际验证结果。`

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
  font-size: var(--text-body);
  line-height: 1.625;
}
.markdown code {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.92em;
  background: var(--muted);
  border-radius: 6px;
  padding: 1px 6px;
}`

const EDIT_DIFF = `--- a/src/gui/styles/globals.css
+++ b/src/gui/styles/globals.css
@@ -1,3 +1,3 @@
 .markdown strong {
-  font-weight: 400;
+  font-weight: 600;
 }`

const REASONING_1 = `这组静态样例包含段落、标题、列表、行内代码和表格，用来观察正文与辅助说明的层级。

Typography preview: compare emphasis, spacing, and wrapping at different viewport widths. 工具行和输出内容也是预设样例。`

// Same text as the supplied Codex screenshot, for comparing rendered type and
// wrapping. It quotes the earlier answer, rather than reporting current checks.
const REFERENCE_PROMPT =
  "你能够用 rea 看出来codex gui 用的是什么字体，就是对话历史展示的设计系统并应用到我们项目里面吗"
const REFERENCE_ANSWER = `已应用到 Yakitori。根据本机 **Codex 26.1029.61003** 的包内默认设置：

- 字体：系统无衬线栈，macOS 通常对应 San Francisco，中文由系统回退。
- 正文：**14px / 22.75px**；代码使用系统等宽字体。
- 已同步标题比例、段落与列表间距、600 字重，以及低对比用户气泡。
- OpenAI Sans 虽然附带在包内，但这版编码对话默认没有启用。

[字体回退说明](https://developer.mozilla.org/en-US/docs/Web/CSS/font-family)

此页面仅供静态排版对照；工具、耗时和状态均为预设样例，不代表当前验证结果。`

function referenceEntries(): ExecutionEntry[] {
  return [
    {
      kind: "user_input",
      inputId: "input_1",
      text: REFERENCE_PROMPT,
      content: textInputDraft(REFERENCE_PROMPT),
      at: at("11:00:00"),
    },
    {
      kind: "assistant",
      itemId: "item_final_1",
      purpose: "final_answer",
      turnId: "turn_1",
      text: REFERENCE_ANSWER,
      status: "completed",
      at: at("11:10:08"),
    },
  ]
}

function activityEntries(): ExecutionEntry[] {
  const callId = "mock_activity"
  return entries().flatMap<ExecutionEntry>((entry) => {
    if (entry.kind === "user_input") {
      const text = "把过程说明、工具动作和最终回答整理清楚，让我能顺着读下来。"
      return entry.inputId === "input_1"
        ? [{ ...entry, text, content: textInputDraft(text) }]
        : []
    }
    if (!("turnId" in entry) || entry.turnId !== "turn_1") return []
    if (entry.kind === "reasoning" && entry.itemId === "item_reason_1")
      return [
        {
          ...entry,
          source: { callId, itemId: entry.itemId },
          text: "先检查过程说明和工具批次的边界，再核对展开后的阅读顺序。",
        },
      ]
    if (entry.kind === "assistant" && entry.itemId === "item_msg_1")
      return [
        {
          ...entry,
          source: { callId, itemId: entry.itemId },
          purpose: "commentary",
          text: "我先检查历史分组和工具摘要，确认哪些信息应该直接显示。",
        },
      ]
    if (entry.kind === "tool" && entry.execution.type === "file_read") {
      const execution = entry.execution
      return [
        "src/gui/components/transcript.tsx",
        "src/gui/tool-presentation.ts",
      ].map((path, index) => {
        const toolCallId = `call_activity_read_${index + 1}`
        return {
          ...entry,
          toolCallId,
          execution: {
            ...execution,
            itemId: `item_activity_read_${index + 1}`,
            toolCallId,
            modelCallId: callId,
            input: { path, offset: 1, limit: 2 },
            path,
            offset: 1,
            limit: 2,
            result: {
              path,
              kind: "file",
              range: { offset: 1, limit: 2 },
              empty: false,
              truncated: false,
            },
          },
          resultText:
            "// Static preview excerpt\n// Process descriptions stay visible between tool batches.",
        }
      })
    }
    if (entry.kind === "tool" && entry.execution.type === "command_execution")
      return [
        {
          ...entry,
          execution: { ...entry.execution, modelCallId: callId },
          resultText:
            "Sample output only; this command was not executed by the preview.",
        },
      ]
    if (entry.kind === "assistant" && entry.itemId === "item_final_1")
      return [
        {
          ...entry,
          itemId: "item_activity_progress",
          source: { callId, itemId: "item_activity_progress" },
          purpose: "commentary",
          text: "工具动作合并为一组，说明文字留在它们之间；子任务保留独立入口。",
          at: at("11:00:35"),
        },
        {
          kind: "tool",
          toolCallId: "call_activity_review",
          turnId: "turn_1",
          state: "completed",
          execution: {
            type: "collaboration_tool_call",
            itemId: "item_activity_review",
            toolCallId: "call_activity_review",
            modelCallId: callId,
            name: "spawn_agent",
            input: {
              task_name: "renderer-review",
              message:
                "Review the process grouping and confirm the reading order.",
            },
            requiresPermission: false,
            action: "spawn",
            description:
              "Review the process grouping and confirm the reading order.",
            receivers: [
              {
                sessionId: "session_mock_renderer_review",
                path: "/root/renderer-review",
              },
            ],
          },
          resultText:
            "Sample response: the child accepted the review task. This does not report completion.",
        },
        {
          ...entry,
          source: { callId, itemId: entry.itemId },
          text: "说明文字、工具批次和子任务入口按发生顺序展示。最终回答独立保留，收起工具细节也能完整阅读。",
          at: at("11:00:48"),
        },
      ]
    return []
  })
}

function entries(): ExecutionEntry[] {
  return [
    {
      kind: "user_input",
      inputId: "input_1",
      text: "帮我把 markdown 排版过一遍：标题、列表、代码块、引用、表格都要看效果，顺便对照一下 Codex 的风格。",
      content: draftFromEditorParts([
        {
          type: "text",
          text: "帮我把 markdown 排版过一遍：标题、列表、代码块、引用、表格都要看效果，顺便对照一下 Codex 的风格。",
        },
      ]),
      at: at("11:00:00"),
    },
    {
      kind: "reasoning",
      itemId: "item_reason_1",
      source: { callId: "mock_inspect", itemId: "item_reason_1" },
      turnId: "turn_1",
      text: REASONING_1,
      status: "completed",
      at: at("11:00:04"),
    },
    {
      kind: "assistant",
      itemId: "item_msg_1",
      source: { callId: "mock_inspect", itemId: "item_msg_1" },
      turnId: "turn_1",
      text: "下面是排版样例，包含正文、工具输出和不同层级的 Markdown 内容。",
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
        modelCallId: "mock_inspect",
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
        modelCallId: "mock_inspect",
        name: "exec_command",
        input: { cmd: "pnpm typecheck" },
        requiresPermission: false,
        command: "pnpm typecheck",
      },
      resultText: "$ tsc --noEmit\n",
    },
    {
      kind: "reasoning",
      itemId: "item_reason_verify",
      source: { callId: "mock_verify", itemId: "item_reason_verify" },
      turnId: "turn_1",
      text: "**检查排版变更与参考资料**",
      representation: "summary",
      status: "completed",
      at: at("11:01:00"),
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
        modelCallId: "mock_verify",
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
        modelCallId: "mock_verify",
        name: "web_search",
        input: { query: "CSS typography reference" },
        requiresPermission: false,
        query: "CSS typography reference",
        result: {
          links: [
            {
              title: "MDN: font-family",
              url: "https://developer.mozilla.org/en-US/docs/Web/CSS/font-family",
            },
            {
              title: "MDN: line-height",
              url: "https://developer.mozilla.org/en-US/docs/Web/CSS/line-height",
            },
          ],
        },
      },
      resultText: "2 results",
    },
    {
      kind: "assistant",
      itemId: "item_final_1",
      source: { callId: "mock_answer_1", itemId: "item_final_1" },
      purpose: "final_answer",
      turnId: "turn_1",
      text: TURN_1_ANSWER,
      status: "completed",
      at: at("11:03:24"),
    },
    {
      kind: "user_input",
      inputId: "input_2",
      text: "表格、引用块、任务列表也看看，再给一个编辑失败的样子。",
      content: draftFromEditorParts([
        {
          type: "text",
          text: "表格、引用块、任务列表也看看，再给一个编辑失败的样子。",
        },
      ]),
      at: at("11:04:00"),
    },
    {
      kind: "assistant",
      itemId: "item_msg_2",
      source: { callId: "mock_fix", itemId: "item_msg_2" },
      purpose: "commentary",
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
        modelCallId: "mock_fix",
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
        modelCallId: "mock_fix",
        name: "exec_command",
        input: { cmd: "pnpm test" },
        requiresPermission: true,
        command: "pnpm test",
      },
      resultText:
        " Test Files  164 passed (164)\n      Tests  1823 passed (1823)\n   Duration  19.27s",
    },
    {
      kind: "assistant",
      itemId: "item_final_2",
      source: { callId: "mock_answer_2", itemId: "item_final_2" },
      purpose: "final_answer",
      turnId: "turn_2",
      text: TURN_2_ANSWER,
      status: "completed",
      at: at("11:05:49"),
    },
    {
      kind: "user_input",
      inputId: "input_3",
      text: "最后看看被打断的 turn 长什么样。",
      content: textInputDraft("最后看看被打断的 turn 长什么样。"),
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

function buildExecution(all: ExecutionEntry[]): ExecutionViewState {
  const itemEntryIndexes: Record<string, number> = {}
  const permissionEntryIndexes: Record<string, number> = {}
  all.forEach((entry, index) => {
    if (
      entry.kind === "assistant" ||
      entry.kind === "reasoning" ||
      entry.kind === "tool"
    ) {
      itemEntryIndexes[
        entry.kind === "tool" ? entry.execution.itemId : entry.itemId
      ] = index
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
      turn_1: {
        inputId: "input_1",
        startedAt: at("11:00:02"),
        completedAt: at("11:03:24"),
      },
      turn_2: {
        inputId: "input_2",
        startedAt: at("11:04:02"),
        completedAt: at("11:05:49"),
      },
      turn_3: {
        inputId: "input_3",
        startedAt: at("11:06:02"),
        completedAt: at("11:06:40"),
      },
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
  const sample = new URLSearchParams(window.location.search).get("sample")
  const reference = sample === "codex"
  const activity = sample === "activity"
  const execution = reference
    ? {
        ...buildExecution(referenceEntries()),
        turnTimings: {
          turn_1: {
            inputId: "input_1",
            startedAt: at("11:00:00"),
            completedAt: at("11:10:08"),
          },
        },
      }
    : activity
      ? {
          ...buildExecution(activityEntries()),
          telemetry: {
            ...createExecutionViewState().telemetry,
            turns: 1,
            steps: 5,
          },
          turnTimings: {
            turn_1: {
              inputId: "input_1",
              startedAt: at("11:00:02"),
              completedAt: at("11:00:48"),
            },
          },
        }
      : buildExecution(entries())
  const session: ApiSessionDetail = {
    id: SESSION_ID,
    rolloutId: `rollout_${SESSION_ID}`,
    conversationId: SESSION_ID,
    seq: 42,
    createdAt: at("11:00:00"),
    updatedAt: at(activity ? "11:00:48" : "11:06:40"),
    title: reference
      ? "Mock · Codex 截图对照"
      : activity
        ? "Mock · 过程信息组织"
        : "Mock · 排版预览",
    workingDirectory: "/Users/hugo/Documents/yakitori",
    pendingInputs: [],
    pendingPermissions: [],
    counts: {
      inputs: reference || activity ? 1 : 3,
      pendingInputs: 0,
      turns: reference || activity ? 1 : 3,
      items: reference ? 1 : activity ? 8 : 11,
      permissions: reference || activity ? 0 : 1,
      tools: reference ? 0 : activity ? 4 : 6,
    },
  }
  useAppStore.setState({
    selection: { sessionId: SESSION_ID },
    selectedSession: session,
    execution,
  })
}
