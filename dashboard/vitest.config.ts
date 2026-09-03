import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (p: string) => fileURLToPath(new URL(`./src/${p}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // Mirror tsconfig's `@/*` -> `src/*`.
      "@": src(""),
      // `server-only` throws when imported outside a React Server environment;
      // these tests import server modules directly, so point it at a stub.
      "server-only": src("test/server-only-stub.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/test/setup.ts"],
  },
});
