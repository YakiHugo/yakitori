import { HostedToolCell } from "./components/cells/hosted-tool-cell.tsx"
import { SourceCode } from "./components/source-code.tsx"
import type { TranscriptPresenterRegistry } from "./components/transcript-presenters.tsx"

// Register independent provider and engine presenters here. The application
// supplies this registry to all transcript slots, including observed sessions.
export const transcriptPresenterRegistry: TranscriptPresenterRegistry = {
  entry: [
    {
      id: "hosted-code",
      entryKind: "hosted_tool",
      matches: ({ entry }) =>
        entry.kind === "hosted_tool" && entry.tool.sourceCode !== undefined,
      replace: ({ context: { entry }, fallback }) =>
        entry.kind !== "hosted_tool" || entry.tool.sourceCode === undefined ? (
          fallback
        ) : (
          <HostedToolCell
            entry={entry}
            code={
              <SourceCode
                code={entry.tool.sourceCode}
                path="hosted.py"
                className="mt-2 max-h-64 overflow-auto"
              />
            }
          />
        ),
    },
  ],
}
