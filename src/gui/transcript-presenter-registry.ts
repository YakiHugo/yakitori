import type { TranscriptPresenterRegistry } from "./components/transcript-presenters.tsx"

// Register independent provider and engine presenters here. The application
// supplies this registry to all transcript slots, including observed sessions.
export const transcriptPresenterRegistry: TranscriptPresenterRegistry = {}
