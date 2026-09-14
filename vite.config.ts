import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
export default defineConfig({
  envDir: false,
  plugins: [react()],
  server: { proxy: { "/api": "http://127.0.0.1:4300" } },
  test: {
    testTimeout: 20000,
    environment: "node",
    include: ["tests/**/*.test.{ts,tsx}"],
    restoreMocks: true,
    fileParallelism: false,
  },
});
