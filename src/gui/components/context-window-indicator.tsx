const compactTokens = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 0,
})

function formatTokens(tokens: number): string {
  return compactTokens.format(tokens).toLowerCase()
}

export function ContextWindowIndicator({
  usedTokens,
  capacity,
}: Readonly<{
  usedTokens?: number | undefined
  capacity?: number | undefined
}>) {
  const validCapacity =
    capacity !== undefined && Number.isFinite(capacity) && capacity > 0
  const validUsage =
    usedTokens !== undefined && Number.isFinite(usedTokens) && usedTokens >= 0
  const usedPercent =
    validCapacity && validUsage
      ? Math.min(100, Math.round((usedTokens / capacity) * 100))
      : undefined
  const remainingPercent =
    usedPercent === undefined ? undefined : 100 - usedPercent
  const usedLabel =
    usedTokens === undefined ? undefined : formatTokens(usedTokens)
  const capacityLabel =
    capacity === undefined ? undefined : formatTokens(capacity)
  const circumference = 2 * Math.PI * 9
  const label =
    usedPercent === undefined
      ? "Context window usage unavailable"
      : `Context window: ${usedPercent}% used, ${remainingPercent}% remaining`

  return (
    <div className="group relative flex shrink-0 items-center">
      <button
        type="button"
        aria-label={label}
        className="grid size-7 place-items-center rounded-full text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="size-[17px] -rotate-90"
          fill="none"
        >
          <circle
            cx="12"
            cy="12"
            r="9"
            stroke="currentColor"
            strokeWidth="3"
            opacity="0.25"
          />
          {usedPercent === undefined ? null : (
            <circle
              cx="12"
              cy="12"
              r="9"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - usedPercent / 100)}
            />
          )}
        </svg>
      </button>
      <div
        role="tooltip"
        className="pointer-events-none invisible absolute bottom-full left-1/2 z-30 mb-2.5 w-[13.75rem] max-w-[80vw] -translate-x-1/2 rounded-[16px] bg-[#191b1d] px-3 py-2 text-center text-[13px] leading-[1.5] font-normal text-white opacity-0 shadow-[0_12px_30px_-10px_#0007] transition-opacity duration-150 group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100"
      >
        <div className="text-white/60">Context window</div>
        {usedPercent === undefined ? (
          <>
            <div>
              {validUsage
                ? `${usedLabel} tokens used`
                : "Usage available after a model response"}
            </div>
            {validCapacity ? <div>{capacityLabel} total</div> : null}
          </>
        ) : (
          <>
            <div>
              {usedPercent}% used ({remainingPercent}% remaining)
            </div>
            <div>
              {usedLabel} tokens used, {capacityLabel} total
            </div>
          </>
        )}
      </div>
    </div>
  )
}
