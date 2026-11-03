// Qwen Code official presets (c26a320, checked 2026-11-03) and vision docs:
// https://github.com/QwenLM/qwen-code/tree/c26a32006a82d516eeb83640f8fc3a4f1243707b/packages/core/src/providers/presets
// https://www.alibabacloud.com/help/en/model-studio/vision
// https://docs.qwencloud.com/developer-guides/multimodal/vision
// Credentials are endpoint-specific; this never redirects or retries elsewhere.
const dashscopeHosts = new Set([
  "dashscope.aliyuncs.com",
  "dashscope-intl.aliyuncs.com",
  "dashscope-us.aliyuncs.com",
  "cn-hongkong.dashscope.aliyuncs.com",
])
const codingHosts = new Set([
  "coding.dashscope.aliyuncs.com",
  "coding-intl.dashscope.aliyuncs.com",
])
const qwenCloudHosts = new Set([
  "maas.qianwenaiapi.com",
  "maas.qwencloudapi.com",
  "token-plan.maas.qianwenaiapi.com",
  "token-plan.maas.qwencloudapi.com",
  "ap-southeast-1.maas.qwencloudapi.com",
])

export type QwenEndpointPolicy = Readonly<{
  requestBytes: number
  requestLimit: string
}>

export function qwenEndpointPolicy(
  baseURL: string,
): QwenEndpointPolicy | undefined {
  const url = URL.parse(baseURL)
  if (
    url?.protocol !== "https:" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  )
    return undefined
  const path = url.pathname.replace(/\/$/, "")
  if (
    (path === "/compatible-mode/v1" && dashscopeHosts.has(url.hostname)) ||
    (path === "/v1" && codingHosts.has(url.hostname))
  )
    return { requestBytes: 16 * 1024 * 1024, requestLimit: "16 MiB DashScope" }
  if (
    path === "/compatible-mode/v1" &&
    (qwenCloudHosts.has(url.hostname) ||
      // A single workspace label, at an explicitly documented region.
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.(?:cn-beijing|ap-southeast-1|us-east-1|cn-hongkong|eu-central-1|ap-northeast-1)\.maas\.aliyuncs\.com$/.test(
        url.hostname,
      ))
  )
    return { requestBytes: 64_000_000, requestLimit: "64 MB Qwen" }
  return undefined
}
