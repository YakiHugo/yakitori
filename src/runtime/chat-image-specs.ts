import type { ImageAdmissionSpec } from "./chat-image-admission.ts"
import { isDoubaoVisionModel } from "./doubao-models.ts"

// Ark's base64 contract: https://docs.volcengine.com/docs/ark/image-understanding?lang=zh
export const doubaoImageSpec = {
  visionModel: {
    matches: isDoubaoVisionModel,
    message:
      "Doubao image input is only supported for the documented Seed Evolving, 2.1 Pro and 2.1 Turbo models.",
  },
  maxImageBytes: {
    bytes: 10_000_000,
    sizeMeasure: "raw",
    exclusive: true,
    message:
      "Doubao image must be smaller than 10 MB. Resize a copy; the original has not been changed.",
  },
  dimensions: {
    accepts: ({ width, height }) =>
      Math.min(width, height) > 14 &&
      width * height <= 36_000_000 &&
      Math.max(width, height) / Math.min(width, height) <= 150,
    message:
      "Doubao images require sides above 14 pixels, at most 36 million pixels and aspect ratio at most 150:1. Resize a copy; the original has not been changed.",
  },
  requestBudget: {
    bytes: 64_000_000,
    encodedMessage: "Doubao request exceeds 64 MB including encoded images.",
    bodyMessage:
      "Doubao request exceeds 64 MB including text, tools and encoded images.",
  },
} satisfies ImageAdmissionSpec

// MiniMax's byte limits are not image-token limits; the service owns resizing.
// https://platform.minimax.io/docs/api-reference/text-openai-api
export const minimaxImageSpec = {
  visionModel: {
    matches: (model) => ["MiniMax-M3", "MiniMax-M3.1-Flash"].includes(model),
    message:
      "Image input is only supported for documented MiniMax M3 and M3.1-Flash models.",
  },
  inlineImageUrls: true,
  maxImageBytes: {
    bytes: 10_000_000,
    sizeMeasure: "raw",
    message:
      "MiniMax image exceeds 10 MB. Resize a copy; the original has not been changed.",
  },
  requestBudget: {
    bytes: 64_000_000,
    encodedMessage: "MiniMax request exceeds 64 MB including encoded images.",
    bodyMessage:
      "MiniMax request exceeds 64 MB including text, tools and encoded images.",
  },
} satisfies ImageAdmissionSpec

const mimoSafetyMessage =
  "MiMo images were not sent: images, text and tools exceed Yakitori's local 64 MB request safety budget (not a published MiMo quota). Send fewer images or reduce content; originals have not been changed."

// MiMo caps the base64 string; the aggregate request budget is local.
// https://mimo.mi.com/docs/en-US/quick-start/usage-guide/multimodal-understanding/image-understanding
export const mimoImageSpec = {
  visionModel: {
    matches: (model) =>
      ["mimo-v2.6-pro", "mimo-v2.6-flash", "mimo-v2.6-pro-ultraspeed"].includes(
        model,
      ),
    message:
      "MiMo images were not sent: select a documented MiMo V2.6 vision model. Unknown and retired models are not assumed compatible; originals have not been changed.",
  },
  onlyWithImages: true,
  maxImageBytes: {
    bytes: 50_000_000,
    sizeMeasure: "base64",
    message:
      "MiMo image was not sent: its base64 string exceeds 50 MB. Compress a copy; the original has not been changed.",
  },
  requestBudget: {
    bytes: 64_000_000,
    encodedMessage: mimoSafetyMessage,
    bodyMessage: mimoSafetyMessage,
  },
} satisfies ImageAdmissionSpec

// Z.AI's schema says under 5M without specifying what it measures. The data URI
// interpretation is conservative; the count and aggregate budgets are local.
// https://docs.z.ai/openapi.json
export const glmImageSpec = {
  allowedMediaTypes: {
    values: ["image/png", "image/jpeg"],
    message:
      "GLM-5.3-Flash supports PNG and JPEG images. Export a PNG or JPEG copy; the original has not been changed.",
  },
  maxPixelsPerSide: {
    value: 6000,
    message:
      "GLM image exceeds 6000 pixels on a side. Resize a copy; the original has not been changed.",
  },
  maxImages: {
    value: 150,
    message:
      "GLM images were not sent: exceeds Yakitori's local 150-image safety bound. Send fewer images; originals have not been changed.",
  },
  maxImageBytes: {
    bytes: 5_000_000,
    exclusive: true,
    sizeMeasure: "data_uri",
    invalidImage: true,
    message:
      "GLM image was not sent: exceeds Yakitori's conservative under-5-MB encoded image admission bound. Compress a copy; the original has not been changed.",
  },
  requestBudget: {
    bytes: 32_000_000,
    sizeMeasure: "data_uri",
    onlyWithImages: true,
    encodedMessage:
      "GLM images were not sent: encoded images exceed Yakitori's local 32 MB request safety budget. Send fewer images; originals have not been changed.",
    bodyMessage:
      "GLM images were not sent: text, tools and images exceed Yakitori's local 32 MB request safety budget. Reduce request content; originals have not been changed.",
  },
} satisfies ImageAdmissionSpec
