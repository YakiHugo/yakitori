import { providerServices } from "./provider-services.ts"

export type { ConfiguredModel, ProviderPreset } from "../protocol/providers.ts"

// Creation templates are a projection of the service definitions. A saved
// account binds its service explicitly; changing its label or template is inert.
export const providerPresets = providerServices.map((service) => ({
  ...service,
}))
