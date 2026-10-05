import { WebSocket } from "ws"
import type {
  RpcMethodParams,
  RpcMethodResponses,
} from "../../src/server/rpc/methods.ts"

export async function createChatGPTRpcClient(baseUrl: string) {
  const ws = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/rpc`)
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve)
    ws.once("error", reject)
  })
  let id = 0
  const frames: string[] = []
  ws.on("message", (data) => frames.push(data.toString()))
  async function request<Method extends keyof RpcMethodParams>(
    method: Method,
    params: RpcMethodParams[Method],
  ): Promise<RpcMethodResponses[Method]> {
    const requestId = ++id
    return new Promise((resolve, reject) => {
      const receive = (data: WebSocket.RawData) => {
        const frame = JSON.parse(data.toString())
        if (frame.id !== requestId) return
        ws.off("message", receive)
        if (frame.error) reject(new Error(frame.error.message))
        else resolve(frame.result)
      }
      ws.on("message", receive)
      ws.send(JSON.stringify({ id: requestId, method, params }))
    })
  }
  await request("initialize", {
    clientInfo: { name: "siwc-fixture", version: "1" },
  })
  return { request, frames, close: () => ws.close() }
}
