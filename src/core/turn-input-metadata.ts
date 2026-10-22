import type { ResponseItemEnvelope } from "./rollout.ts"
import {
  fingerprintTurnInput,
  type InputPurpose,
  type InputSource,
  type TurnInput,
} from "./session-io.ts"

export function inputPurpose(input: TurnInput): InputPurpose {
  return (
    input.purpose ??
    (input.goalId !== undefined || input.source === "agent"
      ? "task"
      : "message")
  )
}

export function inputSource(input: TurnInput): InputSource {
  return (
    input.source ??
    (input.provenance !== undefined
      ? "agent"
      : input.goalId === undefined
        ? "human"
        : "runtime")
  )
}

export function turnInputSubmissionMetadata(
  input: TurnInput,
): Pick<ResponseItemEnvelope, "submissionMetadata"> {
  return {
    submissionMetadata: {
      source: inputSource(input),
      purpose: inputPurpose(input),
      ...(inputSource(input) === "human" &&
      inputPurpose(input) !== "question_answer"
        ? {}
        : { requestFingerprint: fingerprintTurnInput(input) }),
      content: input.content,
      ...(input.provenance === undefined
        ? {}
        : { provenance: input.provenance }),
      ...(input.modelSelection === undefined
        ? {}
        : { modelSelection: input.modelSelection }),
      ...(input.parentInputId === undefined
        ? {}
        : { parentInputId: input.parentInputId }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    },
  }
}
