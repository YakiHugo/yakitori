export function normalizeBrowserUrl(input: string): string {
  const value = input.trim()
  const hostWithPort = /^[^/?#:]+:\d+(?:[/?#]|$)/.test(value)
  const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(value) && !hostWithPort
  let url: URL
  try {
    url = new URL(hasScheme ? value : `https://${value}`)
  } catch {
    throw new TypeError("Enter a valid HTTP or HTTPS address.")
  }
  if (
    !hasScheme &&
    (url.hostname === "localhost" ||
      url.hostname.endsWith(".localhost") ||
      /^127(?:\.\d{1,3}){3}$/.test(url.hostname) ||
      url.hostname === "[::1]")
  ) {
    url.protocol = "http:"
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("Enter an HTTP or HTTPS address.")
  }
  if (url.username || url.password) {
    throw new TypeError(
      "URLs containing usernames or passwords are not supported.",
    )
  }
  return url.href
}

export function isBrowserNavigation(url: string): boolean {
  if (!URL.canParse(url)) return false
  const parsed = new URL(url)
  return (
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    !parsed.username &&
    !parsed.password
  )
}
