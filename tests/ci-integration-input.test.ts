import { describe, expect, test } from "vitest";
import { resolveStudioIntegrationInput } from "../scripts/ci-integration-input";

describe("immutable Studio CI input", () => {
	const studio = {
		repository: "ForgeaX-Games/forgeax-studio",
		revision: "89d8b862c10b7c1bd1d5876a8a03501ac2c620d3",
	};
	test("resolves the declared exact input", () => {
		expect(resolveStudioIntegrationInput({ schemaVersion: 1, studio })).toEqual(
			studio,
		);
	});
	test("rejects missing inputs instead of falling back to main", () => {
		for (const input of [
			null,
			{},
			{ schemaVersion: 1 },
			{ schemaVersion: 2, studio },
		]) {
			expect(() => resolveStudioIntegrationInput(input)).toThrow();
		}
	});
	test("rejects mutable, abbreviated and injectable revisions", () => {
		for (const revision of [
			"main",
			"89d8b862",
			"",
			studio.revision + "\n",
			studio.revision + "\nref=main",
		]) {
			expect(() =>
				resolveStudioIntegrationInput({
					schemaVersion: 1,
					studio: { ...studio, revision },
				}),
			).toThrow();
		}
	});
	test("rejects a different repository", () => {
		expect(() =>
			resolveStudioIntegrationInput({
				schemaVersion: 1,
				studio: { ...studio, repository: "other/repository" },
			}),
		).toThrow();
	});
});
