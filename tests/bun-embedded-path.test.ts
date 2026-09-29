import { describe, expect, test } from "vitest";
import { isBunEmbeddedPath } from "../scripts/bun-embedded-path";

describe("isBunEmbeddedPath", () => {
	test("recognizes POSIX and Windows Bun compiled virtual roots", () => {
		expect(isBunEmbeddedPath("/$bunfs/root/game-charter.md")).toBe(true);
		expect(isBunEmbeddedPath("file:///$bunfs/root/game-charter.md")).toBe(true);
		expect(isBunEmbeddedPath("B:\\~BUN\\root\\game-charter.md")).toBe(true);
		expect(isBunEmbeddedPath("file:///B:/~BUN/root/game-charter.md")).toBe(
			true,
		);
		expect(isBunEmbeddedPath("file:///B:/%7EBUN/root/game-charter.md")).toBe(
			true,
		);
	});

	test("fails closed for malformed URIs and ordinary application paths", () => {
		expect(isBunEmbeddedPath("file:///B:/%ZZ/root/game-charter.md")).toBe(
			false,
		);
		expect(
			isBunEmbeddedPath("C:\\Program Files\\ForgeaX Studio\\game-charter.md"),
		).toBe(false);
		expect(isBunEmbeddedPath("file:///opt/forgeax/game-charter.md")).toBe(
			false,
		);
	});
});
