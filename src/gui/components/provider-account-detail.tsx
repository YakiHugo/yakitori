import { useTranslation } from "../i18n/use-translation.ts"
import { ArrowLeft } from "lucide-react"
import type { ReactNode } from "react"
import type { ApiConfiguredProvider } from "../../protocol/providers.ts"
import { ModelCatalogSettings } from "./model-catalog-settings.tsx"
import { ProviderUsage } from "./provider-usage.tsx"
import { Button } from "./ui/button.tsx"

export function ProviderAccountDetail({
  apiBase,
  accountId,
  name,
  description,
  configuration,
  chatGPT,
  modelsAvailable,
  onBack,
  actions,
}: Readonly<{
  apiBase: string
  accountId: string
  name: string
  description?: string
  configuration?: ApiConfiguredProvider
  chatGPT: boolean
  modelsAvailable: boolean
  onBack(): void
  actions: ReactNode
}>) {
  const { t } = useTranslation()
  return (
    <div className="provider-account-detail">
      <Button type="button" variant="ghost" size="sm" onClick={onBack}>
        <ArrowLeft data-icon="inline-start" />
        {t("Back to accounts")}
      </Button>
      <header className="provider-account-heading">
        <div>
          <h2>{name}</h2>
          {description ? <p>{description}</p> : null}
        </div>
        <div className="provider-account-actions">{actions}</div>
      </header>
      <section
        className="model-catalog-settings"
        aria-label={t("Account models")}
      >
        {modelsAvailable ? (
          <ModelCatalogSettings
            apiBase={apiBase}
            provider={accountId}
            titleModelConfigurable={!chatGPT}
          />
        ) : (
          <p className="provider-field-hint">
            {t("Reconnect this account to manage its models.")}
          </p>
        )}
      </section>
      <ProviderUsage
        apiBase={apiBase}
        accountId={accountId}
        name={name}
        {...(configuration === undefined ? {} : { configuration })}
        chatGPT={chatGPT}
      />
    </div>
  )
}
