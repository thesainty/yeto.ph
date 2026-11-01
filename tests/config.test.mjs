import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

for (const [name, candidate] of [
  ["private-key format", "sb_secret_not_a_real_key"],
  ["legacy or admin JWT format", "eyJ_not_a_real_token"],
]) {
  test(`Vite rejects ${name} before producing browser assets`, () => {
    const temp = mkdtempSync(join(tmpdir(), "yeto-config-"));
    const output = join(temp, "dist");
    try {
      const result = spawnSync(
        process.execPath,
        ["node_modules/vite/bin/vite.js", "build", "--outDir", output],
        {
          cwd: new URL("..", import.meta.url),
          encoding: "utf8",
          env: {
            ...process.env,
            VITE_SUPABASE_URL: "https://yeto-test.supabase.co",
            VITE_SUPABASE_PUBLISHABLE_KEY: candidate,
          },
        },
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /must be a public publishable key/);
      assert.equal(
        (result.stdout + result.stderr).includes(candidate),
        false,
        "Rejected key values must never be printed",
      );
      assert.equal(
        existsSync(output),
        false,
        "Invalid credentials must not produce browser assets",
      );
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
}
