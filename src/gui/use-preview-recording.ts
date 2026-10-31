import { useEffect, useRef, useState } from "react"
import type { ComputerPreviewFrame } from "../protocol/computer-preview.ts"
import { PreviewRecording } from "./preview-recording.ts"

export function usePreviewRecording(
  frame: ComputerPreviewFrame | undefined,
  active: boolean,
  identity: string,
) {
  const current = useRef<
    { recorder: PreviewRecording; identity: string } | undefined
  >(undefined)
  const mounted = useRef(true)
  const savedUrl = useRef<string | undefined>(undefined)
  const [recording, setRecording] = useState(false)
  const [clip, setClip] = useState<{ url: string; name: string }>()
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      void current.current?.recorder.stop()
      if (savedUrl.current) URL.revokeObjectURL(savedUrl.current)
    }
  }, [])
  useEffect(() => {
    // A recording belongs to one viewer/target lifetime. Hidden panels, stopped
    // previews and target switches must never silently record a different app.
    if (!active || current.current?.identity !== identity)
      void current.current?.recorder.stop()
  }, [active, identity])
  useEffect(() => {
    if (frame && active && current.current?.identity === identity)
      current.current.recorder.append(frame)
  }, [frame, active, identity])
  const start = () => {
    if (!active || !frame || current.current) return
    setError(undefined)
    setNotice(undefined)
    try {
      const recorder = new PreviewRecording(frame)
      current.current = { recorder, identity }
      setRecording(true)
      void recorder.finished.then(
        ({ blob, reason }) => {
          if (current.current?.recorder === recorder)
            current.current = undefined
          if (!mounted.current) return
          if (savedUrl.current) URL.revokeObjectURL(savedUrl.current)
          const url = URL.createObjectURL(blob)
          savedUrl.current = url
          setClip({
            url,
            name: `yakitori-preview-${new Date().toISOString().replaceAll(":", "-")}.webm`,
          })
          setRecording(false)
          if (reason === "size")
            setNotice(
              "Recording stopped at its memory safety threshold. Save this clip before starting another.",
            )
        },
        (cause: unknown) => {
          if (current.current?.recorder === recorder)
            current.current = undefined
          if (mounted.current) {
            setRecording(false)
            setError(cause instanceof Error ? cause.message : String(cause))
          }
        },
      )
      recorder.append(frame)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  return {
    recording,
    clip,
    error,
    notice,
    start,
    stop: () => {
      void current.current?.recorder.stop()
    },
  }
}
