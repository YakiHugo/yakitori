import type { ApiSessionSummary } from "../protocol/application.ts"
import { createExecutionViewState } from "./execution-view.ts"
import { useAppStore } from "./store/app-store.ts"
import {
  sessionReadKey,
  useSessionReadStore,
} from "./store/session-read-store.ts"

// Browser preview at ?mock=sidebar; no runtime or provider is required.
export function seedMockSidebar(): void {
  const projectId = "project_sidebar_preview"
  const common = {
    seq: 20,
    createdAt: "2026-11-12T00:00:00Z",
    updatedAt: "2026-11-12T00:00:00Z",
    projectId,
  }
  const samples = [
    {
      id: "preview_working",
      title: "对比细粒度组件实现",
      status: "working",
      active: true,
    },
    {
      id: "preview_waiting",
      title: "等待确认实现方案",
      status: "waiting",
      active: true,
    },
    {
      id: "preview_failed",
      title: "检查 agent browser 和 MCP 内存占用",
      status: "failed",
    },
    {
      id: "preview_unread",
      title: "复刻 Codex 对话历史字体设计",
      status: "idle",
      latestCompletionSeq: 18,
    },
    { id: "preview_idle", title: "更新所有参考项目", status: "idle" },
  ] satisfies Array<Partial<ApiSessionSummary> & { id: string; title: string }>
  const sessions: ApiSessionSummary[] = samples.map((sample) => ({
    ...common,
    ...sample,
    conversationId: sample.id,
  }))
  const readSeqs = { ...useSessionReadStore.getState().readSeqs }
  for (const session of sessions)
    delete readSeqs[sessionReadKey(useAppStore.getState().apiBase, session.id)]
  useSessionReadStore.setState({ readSeqs })
  useAppStore.setState({
    projects: [
      {
        id: projectId,
        name: "yakitori",
        roots: ["/workspace/yakitori"],
        metadata: {},
        position: 0,
        pinned: false,
        createdAt: 0,
        updatedAt: 0,
      },
    ],
    currentProject: projectId,
    collapsedProjects: {},
    sessionsByProject: {
      "sidebar:section:pinned": { sessions: [] },
      [projectId]: { sessions },
    },
    loadSessions: async () => true,
    selectSession: async (sessionId, supplied) => {
      if (supplied === undefined) return
      useAppStore.setState({
        selection: { sessionId },
        selectedSession: {
          ...supplied,
          pendingInputs: [],
          pendingPermissions: [],
          counts: {
            inputs: 0,
            pendingInputs: 0,
            turns: 0,
            items: 0,
            permissions: 0,
            tools: 0,
          },
        },
        execution: { ...createExecutionViewState(), lastSeq: supplied.seq },
      })
    },
  })
}
