import { defineConfig } from "vitest/config";
import { BUN_TEST_FILES } from "./scripts/bun-test-files";

export default defineConfig({
	resolve: { dedupe: ["react", "react-dom"] },
	test: {
		// Fork isolation also keeps DOM globals and module state local to each file.
		pool: "forks",
		server: { deps: { inline: ["@forgeax/app-shell"] } },
		fileParallelism: false,
		testTimeout: 15_000,
		hookTimeout: 60_000,
		projects: [
			{
				extends: true,
				test: {
					name: "unit",
					include: ["tests/**/*.test.{ts,tsx,mjs}"],
					exclude: [...BUN_TEST_FILES],
				},
			},
			{
				extends: true,
				test: {
					name: "e2e",
					include: ["tests/e2e/**/*.spec.ts"],
					testTimeout: 120_000,
				},
			},
		],
	},
});
