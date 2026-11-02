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

## Direct Gemini GenerateContent images

The registered direct `https://generativelanguage.googleapis.com/v1beta`
GenerateContent endpoint now delegates image sizing to Gemini: in requests with
images and **no native document blocks**, validated local image bytes are sent
unchanged, with their sniffed MIME type. This applies to user and tool images,
including stored file references and inline data. No local 2048 resize, JPEG
quality change, or `media_resolution` override is introduced. Unknown model IDs
at this confirmed endpoint use the same protocol policy, not a guessed model
resolution or token budget. This can send more pixels/bytes than the previous
2048 preparation; it does not promise lower cost or better model understanding.

This slice uses a **20,000,000-byte Yakitori application request budget**. It is
not a claim that Gemini universally rejects larger requests: the image guide
says 20 MB while the newer file-input table says 100 MB; that documentation
conflict remains unresolved. The conservative local guard bounds preparation
and reports how to reduce the request, retaining originals and the draft.
The existing 3,600-image GenerateContent count limit is checked before reads.

The budget includes actual request JSON structure, text, tools and controls,
not just decoded image bytes. A plain-JSON UTF-8 counter first measures the
serializer's image-empty shape without allocating a complete JSON string.
Image base64 lengths and actual MIME differences are then added incrementally,
before encoding each image; a failing image stops further asset reads. The
final body is checked again before serialization and the model call. This
bounds wire preparation, not total process RSS or the decoder's existing pixel
limit. There are no uploads on this selected no-document route.

User GIF input is preserved: the GenerateContent Blob API schema explicitly
lists GIF. This does not promise animation-frame interpretation. Yakitori's
existing Gemini 3 native function-response route still supports only PNG,
JPEG and WebP; other formats now produce a clear local error with an export
suggestion instead of an unrelated streaming-response error. No silent first-
frame conversion or OCR fallback is added.

Requests containing native documents, Interactions, unregistered v1
GenerateContent and proxy endpoints retain their existing preparation. PDF
raster pixels already prepared at 2048 cannot be recovered here; when the final
request has no document blocks, other ordinary images can still use the new
policy. Switching models/providers reprojects available
stored resources; historical derived bytes are not magically restored originals.

References (verified 2026-11-02):
[image guide](https://ai.google.dev/gemini-api/docs/generate-content/image-understanding),
[file input methods](https://ai.google.dev/gemini-api/docs/file-input-methods),
[Blob schema](https://ai.google.dev/api/generate-content#Blob),
[media resolution](https://ai.google.dev/gemini-api/docs/generate-content/media-resolution).

## Direct Moonshot Responses images

The existing `kimi-k3` Responses profile at `https://api.moonshot.ai/v1`
uses a separate static-image policy. Static PNG, JPEG and WebP retain their
source bytes up to a 4096-pixel long edge and 2160-pixel short edge. Above that,
safe static 8-bit sRGB/grayscale images without embedded color metadata can be
oriented and proportionally reduced once to PNG, without enlargement and with
alpha preserved, only when this reduces bytes. This adopts Moonshot's **recommended** 4K envelope, including
portrait orientation; it is not an API image-size rejection threshold.
If conversion would lose color-profile/high-bit-depth/gamma semantics, or the
PNG derivative is not smaller than the source, the original bytes are retained
and the provider owns sizing. The stored source is never overwritten. For
example, a generated 5000×2800 JPEG was 8.57 MB but its 4K PNG derivative was
23.30 MB: retaining the JPEG avoids an artificial local-budget failure. This is
why the recommendation is not enforced as a mandatory size cap.

Moonshot documents dynamic image token consumption: retaining more pixels than
the previous 2048 preparation can increase visual tokens, cost and latency.
No exact billing estimate or cost reduction is promised. Validated single-frame
GIF retains its palette and transparent pixels as original bytes. Animated GIF,
APNG and WebP are not silently flattened or sent as videos by this static-only slice;
exporting a static PNG/JPEG/WebP copy is the explicit remedy. Moonshot documents
that animated GIF/WebP can be interpreted and charged as video, which is why
raw animation passthrough is not interchangeable with still-image support.

The complete request has a **20,000,000-byte Yakitori resource guard**, using the
same incremental JSON/base64 accounting as the Gemini slice. This deliberately
smaller application boundary is not Moonshot's documented 100M request limit.
Oversize failures preserve originals and drafts and suggest fewer images,
smaller exported copies or shorter other content. There is no file-upload
fallback. Kimi Responses already rejects native PDF input before preparation;
previously rasterized PDF pixels cannot be restored. Its existing URL inlining
remains necessary because the provider does not support external image URLs.

This policy does not apply to Kimi Code subscriptions, other Responses-compatible
endpoints, or new model IDs. Current Kimi Code CLI documentation specifies a
2000-pixel maximum edge across image entry points; its separate 256 KiB default
read budget applies to agent image reads, not all user attachments. Neither is
an API-wide image limit, and neither is applied to Moonshot Responses here.

References (verified 2026-11-02):
[Moonshot vision and limits](https://platform.kimi.ai/docs/guide/use-kimi-vision-model),
[Responses contract](https://platform.kimi.ai/docs/api/responses),
[Kimi Code image configuration](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/config-files.html#image).
