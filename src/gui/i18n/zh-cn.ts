import { zhCNShell } from "./zh-cn/shell.ts"
import { zhCNSettings } from "./zh-cn/settings.ts"
import { zhCNWorkspace } from "./zh-cn/workspace.ts"
import { zhCNTranscript } from "./zh-cn/transcript.ts"
import { zhCNTools } from "./zh-cn/tools.ts"
import { zhCNCommon } from "./zh-cn/common.ts"

export const zhCN = {
  ...zhCNShell,
  ...zhCNSettings,
  ...zhCNWorkspace,
  ...zhCNTranscript,
  ...zhCNTools,
  ...zhCNCommon,
} as const
