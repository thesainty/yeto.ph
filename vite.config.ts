import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const configuration = loadEnv(mode, process.cwd(), "VITE_SUPABASE_");
  const publicKey = configuration.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
  // VITE_ values are embedded in browser assets. Fail before bundling a private key;
  // a runtime UI warning alone would be too late to prevent its exposure.
  if (publicKey && !publicKey.startsWith("sb_publishable_")) {
    throw new Error(
      "VITE_SUPABASE_PUBLISHABLE_KEY must be a public publishable key. Private or legacy keys cannot be bundled. See docs/CONNECT-SUPABASE.md.",
    );
  }
  return {
    plugins: [react()],
    build: {
      rollupOptions: {
        output: { manualChunks: { supabase: ["@supabase/supabase-js"] } },
      },
    },
  };
});
