import { Server } from "lucide-react"
import anthropic from "../assets/provider-icons/anthropic.svg"
import deepseek from "../assets/provider-icons/deepseek.svg"
import gemini from "../assets/provider-icons/gemini.svg"
import glm from "../assets/provider-icons/glm.svg"
import minimax from "../assets/provider-icons/minimax.svg"
import mistral from "../assets/provider-icons/mistral.svg"
import ollama from "../assets/provider-icons/ollama.svg"
import lmstudio from "../assets/provider-icons/lmstudio.svg"
import openrouter from "../assets/provider-icons/openrouter.svg"
import siliconflow from "../assets/provider-icons/siliconflow.svg"
import moonshot from "../assets/provider-icons/moonshot.svg"
import openai from "../assets/provider-icons/openai.svg"
import qwen from "../assets/provider-icons/qwen.svg"
import xai from "../assets/provider-icons/xai.svg"

// Brand assets are from lobehub/lobe-icons (MIT); the license ships beside them.
const logos: Record<string, { url: string; monochrome?: boolean }> = {
  openai: { url: openai, monochrome: true },
  anthropic: { url: anthropic },
  gemini: { url: gemini },
  xai: { url: xai, monochrome: true },
  deepseek: { url: deepseek },
  qwen: { url: qwen },
  moonshot: { url: moonshot, monochrome: true },
  glm: { url: glm },
  minimax: { url: minimax },
  mistral: { url: mistral },
  "kimi-code": { url: moonshot, monochrome: true },
  ollama: { url: ollama, monochrome: true },
  "lm-studio": { url: lmstudio, monochrome: true },
  openrouter: { url: openrouter, monochrome: true },
  siliconflow: { url: siliconflow },
}

export function ProviderLogo({
  preset,
}: Readonly<{ preset: string | undefined }>) {
  const logo = preset === undefined ? undefined : logos[preset]
  return (
    <span className="provider-logo" aria-hidden="true">
      {logo === undefined ? (
        <Server size={23} />
      ) : logo.monochrome ? (
        <span style={{ maskImage: `url("${logo.url}")` }} />
      ) : (
        <img src={logo.url} alt="" />
      )}
    </span>
  )
}
