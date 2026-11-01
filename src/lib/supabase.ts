import { createClient } from "@supabase/supabase-js";

export type AccountConfiguration = "ready" | "unconfigured" | "invalid";
const projectUrl = (import.meta.env.VITE_SUPABASE_URL ?? "").trim();
const publicKey = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "").trim();

function getConfiguration(): AccountConfiguration {
  if (!projectUrl && !publicKey) return "unconfigured";
  if (!projectUrl || !publicKey) return "invalid";
  try {
    const url = new URL(projectUrl);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      return "invalid";
    if (publicKey.startsWith("sb_secret_")) return "invalid";
    // Accept only publishable keys. A server's service-role key must never reach a browser build.
    if (!publicKey.startsWith("sb_publishable_")) return "invalid";
    return "ready";
  } catch {
    return "invalid";
  }
}
export const accountConfiguration = getConfiguration();
export const supabase =
  accountConfiguration === "ready"
    ? createClient(projectUrl, publicKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          flowType: "pkce",
        },
      })
    : null;
