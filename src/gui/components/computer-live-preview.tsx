import { Circle, Maximize2, Pause, Play, RefreshCw, Square } from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"
import type {
  ComputerPreviewCatalog,
  ComputerPreviewFrame,
} from "../../protocol/computer-preview.ts"
import { getAppRpcClient } from "../lib/rpc-client.ts"
import { usePreviewRecording } from "../use-preview-recording.ts"
import { ImageLightbox } from "./image-lightbox.tsx"
import { Button } from "./ui/button.tsx"
import { Field, FieldGroup, FieldLabel } from "./ui/field.tsx"
import { Select } from "./ui/select.tsx"

function stopPreview(apiBase: string, viewerId: string): void {
  void getAppRpcClient(apiBase)
    .request("computer/preview/stop", { viewerId })
    .catch((cause: unknown) => {
      console.error("Computer preview cleanup failed", cause)
    })
}

export function ComputerLivePreview({
  apiBase,
  active,
  enabled,
}: {
  apiBase: string
  active: boolean
  enabled: boolean
}) {
  const labelId = useId()
  const [visible, setVisible] = useState(document.visibilityState === "visible")
  const [targets, setTargets] = useState<ComputerPreviewCatalog["targets"]>([])
  const [viewerId, setViewerId] = useState<string>()
  const [selectedId, setSelectedId] = useState("")
  const selected = useRef("")
  const generation = useRef(0)
  const [loading, setLoading] = useState(false)
  const [pending, setPending] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string>()
  const [frame, setFrame] = useState<{
    viewerId: string
    targetId: string
    value: ComputerPreviewFrame
  }>()
  const [enlarged, setEnlarged] = useState(false)
  const available = active && visible && enabled
  const target = targets.find((entry) => entry.id === selectedId)?.target
  const image =
    available && frame?.targetId === selectedId && frame.viewerId === viewerId
      ? frame.value
      : undefined
  const recording = usePreviewRecording(
    image,
    available && running,
    `${viewerId}/${selectedId}`,
  )

  useEffect(() => {
    const update = () => setVisible(document.visibilityState === "visible")
    document.addEventListener("visibilitychange", update)
    return () => document.removeEventListener("visibilitychange", update)
  }, [])

  useEffect(() => {
    if (!enabled) setRunning(false)
  }, [enabled])

  useEffect(() => {
    // Each visible lifetime owns an identity. Late cleanup from a hidden panel
    // must never stop a newly opened viewer on the same RPC connection.
    setFrame(undefined)
    setViewerId(undefined)
    setLoading(false)
    setPending(false)
    if (!available) return
    const id = `preview_${refresh}_${crypto.randomUUID()}`
    let stopped = false
    setViewerId(id)
    setLoading(true)
    setError(undefined)
    void getAppRpcClient(apiBase)
      .request("computer/preview/catalog", { viewerId: id })
      .then((catalog) => {
        if (stopped) return
        setTargets(catalog.targets)
        const previous = selected.current
        if (
          previous &&
          !catalog.targets.some((entry) => entry.id === previous)
        ) {
          selected.current = ""
          setSelectedId("")
          setRunning(false)
          setError(
            "The preview target closed or restarted. Choose a target again.",
          )
        } else {
          const next = previous || catalog.targets[0]?.id || ""
          selected.current = next
          setSelectedId(next)
        }
      })
      .catch((cause: unknown) => {
        if (!stopped) {
          setError(cause instanceof Error ? cause.message : String(cause))
          setRunning(false)
        }
      })
      .finally(() => {
        if (!stopped) setLoading(false)
      })
    return () => {
      stopped = true
      generation.current++
      stopPreview(apiBase, id)
    }
  }, [apiBase, available, refresh])

  useEffect(() => {
    if (!available || !running || loading || !viewerId || !target) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const epoch = ++generation.current
    const capture = async () => {
      if (stopped || generation.current !== epoch) return
      setPending(true)
      let completed = false
      try {
        const value = await getAppRpcClient(apiBase).request(
          "computer/preview/capture",
          { viewerId, target },
        )
        if (!stopped && generation.current === epoch) {
          setFrame({ viewerId, targetId: selectedId, value })
          setError(undefined)
          completed = true
        }
      } catch (cause) {
        if (!stopped && generation.current === epoch) {
          setError(cause instanceof Error ? cause.message : String(cause))
          setRunning(false)
        }
      } finally {
        if (!stopped && generation.current === epoch) {
          setPending(false)
          // Bound capture CPU and RPC bandwidth, with no overlapping frames or
          // timer catch-up after a slow native capture. This is not a frame quota.
          if (completed)
            timer = setTimeout(() => {
              void capture()
            }, 750)
        }
      }
    }
    void capture()
    return () => {
      stopped = true
      clearTimeout(timer)
      if (generation.current === epoch) generation.current++
      stopPreview(apiBase, viewerId)
    }
  }, [apiBase, available, running, loading, viewerId, target, selectedId])

  const pointer = image?.pointer
  const pointerVisible =
    image &&
    pointer &&
    pointer.x >= image.frame.x &&
    pointer.y >= image.frame.y &&
    pointer.x < image.frame.x + image.frame.width &&
    pointer.y < image.frame.y + image.frame.height
  return (
    <section aria-label="Live computer preview" className="flex flex-col gap-3">
      <p className="text-xs font-medium">Live preview</p>
      {enabled ? (
        <FieldGroup>
          <Field data-invalid={error !== undefined}>
            <FieldLabel htmlFor={labelId}>Preview target</FieldLabel>
            <Select
              id={labelId}
              aria-invalid={error !== undefined}
              value={selectedId}
              disabled={loading || pending}
              options={targets.map((entry) => ({
                value: entry.id,
                label: entry.label,
              }))}
              placeholder={loading ? "Finding windows…" : "Choose a target"}
              onValueChange={(id) => {
                generation.current++
                selected.current = id
                setSelectedId(id)
                setFrame(undefined)
                setError(undefined)
              }}
            />
            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
          </Field>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={loading || !target || !available}
              onClick={() => {
                generation.current++
                setPending(false)
                setRunning((value) => !value)
              }}
            >
              {running ? (
                <Pause data-icon="inline-start" />
              ) : (
                <Play data-icon="inline-start" />
              )}
              {running ? "Stop preview" : "Start preview"}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Refresh preview targets"
              disabled={running || loading}
              onClick={() => setRefresh((value) => value + 1)}
            >
              <RefreshCw />
            </Button>
            <span role="status" className="text-xs text-muted-foreground">
              {running && available
                ? pending
                  ? "Updating…"
                  : "Live"
                : image
                  ? "Paused"
                  : "Stopped"}
            </span>
          </div>
        </FieldGroup>
      ) : (
        <p className="text-xs text-muted-foreground">
          Allow Screen Recording to preview apps.
        </p>
      )}
      {image && (
        <>
          <div
            className="relative mx-auto"
            style={{
              width: `min(100%, ${image.width * Math.min(1, 288 / image.height)}px)`,
              aspectRatio: `${image.width}/${image.height}`,
            }}
          >
            <Button
              variant="ghost"
              className="block h-full w-full p-0"
              aria-label="Enlarge live computer preview"
              onClick={() => setEnlarged(true)}
            >
              <img
                src={image.dataUrl}
                alt="Live computer preview"
                className="size-full rounded border object-contain"
              />
            </Button>
            {pointerVisible && (
              <span
                role="img"
                aria-label="Pointer position"
                className="pointer-events-none absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-primary bg-background shadow"
                style={{
                  left: `${((pointer.x - image.frame.x) / image.frame.width) * 100}%`,
                  top: `${((pointer.y - image.frame.y) / image.frame.height) * 100}%`,
                }}
              />
            )}
          </div>
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <time dateTime={image.receivedAt}>
              Updated {new Date(image.receivedAt).toLocaleTimeString()}
            </time>
            <Maximize2 size={12} aria-hidden="true" />
          </div>
        </>
      )}
      {enlarged && image && (
        <ImageLightbox
          src={image.dataUrl}
          name="Live computer preview"
          onClose={() => setEnlarged(false)}
        />
      )}
      <div className="space-y-3 border-t pt-3">
        <Button
          variant="outline"
          size="sm"
          disabled={!recording.recording && (!image || !running || !available)}
          onClick={recording.recording ? recording.stop : recording.start}
        >
          {recording.recording ? (
            <Square data-icon="inline-start" />
          ) : (
            <Circle data-icon="inline-start" />
          )}
          {recording.recording ? "Stop recording" : "Record preview"}
        </Button>
        <p className="text-xs text-muted-foreground">
          Record received preview frames and pointer positions without audio.
          Recording stops when this preview stops, hides, or changes target.
        </p>
        {recording.error && (
          <p role="alert" className="text-xs text-destructive">
            {recording.error}
          </p>
        )}
        {recording.notice && (
          <p role="status" className="text-xs text-muted-foreground">
            {recording.notice}
          </p>
        )}
        {recording.clip && (
          <>
            <video
              aria-label="Recorded computer preview"
              src={recording.clip.url}
              controls
              muted
              preload="auto"
              className="w-full rounded border"
            />
            <Button variant="outline" size="sm" asChild>
              <a href={recording.clip.url} download={recording.clip.name}>
                Save recording
              </a>
            </Button>
          </>
        )}
      </div>
    </section>
  )
}
