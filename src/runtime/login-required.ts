// Only missing, unusable or vendor-rejected credentials require interaction.
// Network and filesystem failures must not silently launch a new sign-in.
export class LoginRequiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LoginRequiredError"
  }
}
