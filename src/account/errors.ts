export function accountError(error: unknown): Error {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "";
  const messages: Record<string, string> = {
    invalid_credentials:
      "That email and password don’t match. Please try again.",
    email_not_confirmed:
      "Please confirm your email using the link in your inbox, then sign in.",
    email_address_invalid: "Please enter a valid email address.",
    weak_password: "Choose a stronger password with at least 10 characters.",
    over_email_send_rate_limit:
      "Too many emails were requested. Please wait a little before trying again.",
    over_request_rate_limit:
      "Too many attempts. Please wait a little and try again.",
    signup_disabled: "New accounts are not enabled for this project yet.",
    email_provider_disabled:
      "Email sign-in needs to be enabled in the Supabase project.",
    user_already_exists:
      "Try signing in, or use password recovery if you already have an account.",
    same_password: "Choose a different password from your current one.",
    otp_expired: "This email link has expired. Please request a new one.",
    bad_code_verifier:
      "Open this link in the same browser that requested it, or request a fresh link.",
    flow_state_not_found:
      "This email link is no longer valid. Please request a fresh link.",
    flow_state_expired:
      "This email link has expired. Please request a fresh link.",
    "23505":
      "That username or connection already exists. Please refresh or choose another username.",
    "23514":
      "Check the details: usernames use 3–40 lowercase letters, numbers, or underscores.",
    "42501":
      "You don’t have permission to do that. Please sign in again or refresh your connections.",
    P0001:
      "That action is no longer available. Refresh your connections and try again.",
    PGRST202:
      "The account database setup is missing. Apply the TARA migration in the setup guide.",
    "42P01":
      "The account database setup is missing. Apply the TARA migration in the setup guide.",
    PGRST116:
      "Your profile isn’t available yet. Check the database setup, then try again.",
  };
  if (messages[code]) return new Error(messages[code]);
  if (error instanceof TypeError || code === "network_error")
    return new Error(
      "We couldn’t reach TARA’s account service. Check your connection and try again.",
    );
  return new Error(
    "We couldn’t complete that request. Please try again or check the project setup.",
  );
}
