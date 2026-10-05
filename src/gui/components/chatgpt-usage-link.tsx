import { openUrlTarget } from "../lib/open-resource.ts"
import { useAppStore } from "../store/app-store.ts"

// Canonical destination from the official Sign in with ChatGPT UI guidelines.
export const chatGPTUsageURL = "https://chatgpt.com/settings/usage"

export function ChatGPTUsageLink() {
  return (
    <a
      href={chatGPTUsageURL}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => {
        event.preventDefault()
        void openUrlTarget({ kind: "url", url: chatGPTUsageURL }).catch(() => {
          useAppStore.setState({
            message: "Could not open ChatGPT usage settings. Try again.",
          })
        })
      }}
    >
      Manage usage ↗
    </a>
  )
}
