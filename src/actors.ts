export const ActorKind = {
  Mate: "mate",
  System: "system",
  User: "user",
} as const

export type ActorKind = (typeof ActorKind)[keyof typeof ActorKind]

export type ActorRef = {
  readonly id: string
  readonly kind: ActorKind
}
