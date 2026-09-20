export type NotificationPermissionState =
  | "granted"
  | "denied"
  | "default"
  | "unsupported"

export type NotificationDeliveryResult =
  | "sent"
  | "suppressed"
  | "denied"
  | "unsupported"
  | "failed"

export type CompletionNotificationRequest = Readonly<{
  title: string
  body: string
  mode: "unfocused" | "always"
  sound: boolean
}>

export type CompletionNotificationBridge = Readonly<{
  permission(): Promise<NotificationPermissionState>
  show(input: CompletionNotificationRequest): Promise<NotificationDeliveryResult>
}>
