# Image preparation

Original attachment bytes remain in rollout storage. Request projection may
produce a temporary representation; it never overwrites the original. Quality
adaptation does not require a composer setting or a quality confirmation.

## Native Claude standard-tier requests

The official Anthropic Messages endpoint, with `claude-sonnet-4-6`,
`claude-opus-4-6`, or `claude-haiku-4-5`, delegates image resizing to Claude when
there are images and no PDF/document blocks in the request. Endpoint identity
and protocol—not the editable provider label—select this policy. Unknown
models on that confirmed endpoint retain their source bytes, receive common
protocol/local-budget checks, and fail clearly if resizing would be required;
no resolution tier is inferred. Compatible endpoints and other protocols keep
their existing behavior pending their own documented policies—not a newly
chosen cross-provider compression standard. A final request containing native PDF/document blocks also uses
the existing 2048 preparation. Native extension tools and legacy SDK body
controls (`user_profile_id`, `output_format`, body-level `betas`) also retain the earlier route: hosted
computer/browser screenshots have different limits, and those SDK controls can
rewrite the wire body.

Locally available images are fully decoded for validity before sending, using
the existing bounded decoder and first-frame policy. A valid source fitting the
native admission limits is sent byte-for-byte, keeping JPEG/PNG/WebP/GIF,
transparency and metadata. This avoids a local 2048 resize followed by Claude's
own resize, and avoids converting an already-compressed JPEG into a larger PNG.
It does not add JPEG recompression, palette reduction, or animation support.
Claude uses only the first frame of an animated image.

The documented admission limits are 8000 pixels per side, 10 MB **base64** per
image, and at most 100 images for the 200k-context Haiku model or 600 for the
listed 1M-context models. For more than 20 images, a conservative documented
cross-platform bound of 3000 pixels per side applies. For an unknown native
model, only the shared absolute maximum of 600 images is checked; a lower
model-specific allowance may still be enforced by the provider. Every historical, user,
tool and URL image occurrence counts, not just unique files. Decimal MB is
used conservatively.

If a local source exceeds its image limit, preparation derives a PNG using
Claude's documented **standard-tier** fit: largest aspect-preserving dimensions
with a 1568-pixel padded edge and at most 1568 patches of 28 × 28 pixels.
There is no enlargement. For example, 1920 × 1080 becomes 1456 × 819 and
1075 × 1520 becomes 924 × 1307—not simply a 1568-long-edge fit.

Automatic conversion is limited to static 8-bit sRGB/grayscale images without
an ICC profile or PNG gamma/chromaticity/HDR color-control chunks. It preserves alpha and applies EXIF orientation before sizing;
PNG encoding does not introduce JPEG recompression or palette quantization.
It is still resampling, and is not guaranteed pixel-identical to the service's
implementation. Animated (including APNG), high-bit-depth, color-metadata-bearing or other-color-space sources
remain byte-identical when admissible; if they require conversion, the request
fails with an actionable export/crop suggestion rather than silently altering
those semantics. The original is never changed. A valid small image can be
re-encoded at unchanged dimensions if that alone removes excess encoded bytes.
An incremental image-data lower bound limits candidate accumulation before
materializing the entire batch. Crossing 32 MB discards that candidate pass and
rebuilds once from the original sources with the bounded fallback.
The complete serialized request—including text, system content and tools—is
checked against Yakitori's retained **32 MB internal safety budget** before any
model call. This is not Claude's official ceiling: current direct Messages API
documentation specifies 128 MB. The existing local resource budget is retained
separately rather than silently enlarged. If it is too large, the same
provider-specific fit is tried, retaining each candidate only if it reduces bytes.
An image or request still too large fails explicitly with a repair suggestion;
no image is silently dropped. There is no repeated quality-reduction loop.

The native **standard** vision tier is unchanged: Claude still chooses its
model-native downscaling (1568 long edge / 1568 visual-token maximum). This is
not a claim of identical output quality, identical token count, or cost savings:
rounding and source aspect ratio can affect patches, and fewer transmitted
bytes do not necessarily mean fewer billed tokens. Newer high-resolution
Claude models are deliberately not opted in by name-prefix inference.

## What history can recover

User attachments, `view_image` snapshots and MCP image payloads are stored before
request preparation. Those retained bytes can be reprojected for a different
provider without inheriting a previous request's resize. An MCP producer or
screenshot tool may itself have supplied a derived image; that retained image
is the best available source, not proof of camera/file-original pixels. Older
inline history is likewise reused as stored. Missing assets or pixels discarded
before persistence cannot be recreated by this policy. External URL contents
are not an immutable local snapshot.

## Boundaries and failures

- URL images retain provider-owned fetching. Yakitori does not fetch external
  URLs just to inspect or compress them; their content limits remain enforced
  by the provider, while their count and URL JSON contribute to local budgets.
- PDF raster fallback images retain their earlier 2048 preparation. If a PDF
  has already become raster images/text and the final request contains no native
  document blocks, ordinary local images in that request can use the native
  policy. Native PDF/image requests retain legacy image preparation before
  uploads. This slice does not solve whole-request admission
  before Files API uploads: final uploaded file IDs are only known afterward.
- A UI preview failure does not prove model vision failed. Likewise, successful
  decode or HTTP acceptance does not prove the model understood the image.
- Invalid local image pixels, unreadable assets, and oversize requests are
  explicit failures. Originals are retained. There is no silent OCR substitute,
  image omission, or provider switch. Provider-reported failures use the normal
  request error path; the assistant must not claim to have seen an omitted image.

References (verified 2026-11-02):
[Claude vision](https://platform.claude.com/docs/en/build-with-claude/vision),
[resizing and coordinates](https://platform.claude.com/docs/en/build-with-claude/vision-coordinates),
[request-size limits](https://platform.claude.com/docs/en/api/errors#request-size-limits).

This implementation is only for the confirmed direct Claude Messages API. It
is not the Claude Code client algorithm, and does not assign those limits to
Bedrock, Google-hosted Claude, Kimi-compatible Messages, or any other endpoint.
The vision reference currently distinguishes direct Claude's 10 MB encoded
image allowance from Bedrock's 5 MB allowance; those transports require their
own implementation and tests rather than inheriting this direct-API policy.
