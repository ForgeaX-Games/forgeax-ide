import { describe, expect, test } from "vitest";
import contract from "../../release/contract.json";
import { missingSecretNames } from "../../scripts/check-release-secrets";
import { validateRevisionShape } from "../../scripts/verify-release-revisions";

describe("immutable release inputs and secret contract", () => {
	test("requires exact immutable IDE and integration SHAs", () => {
		expect(() =>
			validateRevisionShape({ name: "ide", expected: "a".repeat(40) }),
		).not.toThrow();
		expect(() =>
			validateRevisionShape({ name: "ide", expected: "main" }),
		).toThrow("exact 40-character SHA");
		expect(() =>
			validateRevisionShape({ name: "studio", expected: "a".repeat(39) }),
		).toThrow("exact 40-character SHA");
	});

	test("reports secret names only and keeps notification non-authoritative", () => {
		expect(missingSecretNames("integration", {})).toEqual(["INTERNAL_TOKEN"]);
		expect(contract.secretNames).toEqual({ integration: ["INTERNAL_TOKEN"] });
		expect(contract.optionalNotificationSecret).toBe("WECOM_WEBHOOK_KEY");
		expect(Object.values(contract.secretNames).flat()).not.toContain(
			"WECOM_WEBHOOK_KEY",
		);
		expect(JSON.stringify(contract)).not.toContain("MIRROR_TOKEN");
	});
});
