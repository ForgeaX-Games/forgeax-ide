import { describe, expect, test } from "vitest";
import candidate from "../../release/schemas/candidate.v1.schema.json";
import evidence from "../../release/schemas/platform-evidence.v1.schema.json";
import recovery from "../../release/schemas/recovery.v1.schema.json";
import transport from "../../release/transport-contract.v1.json";

describe("versioned public Release transport schemas", () => {
	test("publishes strict candidate, platform evidence, and recovery schemas", () => {
		for (const schema of [candidate, evidence, recovery]) {
			expect(schema.$id).toMatch(
				/^https:\/\/github\.com\/ForgeaX-Games\/forgeax-ide\/blob\/main\/release\/schemas\//,
			);
			expect(schema.additionalProperties).toBe(false);
			expect(schema.type).toBe("object");
		}
		expect(candidate.properties.schema.const).toBe(
			"forgeax-ide-release-candidate/v1",
		);
		expect(evidence.properties.schema.const).toBe(
			"forgeax-ide-platform-evidence/v1",
		);
		expect(recovery.properties.schema.const).toBe(
			"forgeax-ide-release-recovery/v1",
		);
	});

	test("keeps the Studio-facing transport derivable without IDE source reach-in", () => {
		expect(transport.schema).toBe("forgeax-ide-release-transport/v1");
		expect(transport.sourceRepository).toBe("ForgeaX-Games/forgeax-ide");
		expect(transport.releaseRepository).toBe("ForgeaX-Games/forgeax-studio");
		const target = candidate.properties.target.properties;
		expect(target.repository.const).toBe(transport.releaseRepository);
		for (const version of ["0.1.0", "0.3.31-alpha.1"])
			expect(`${transport.tagPrefix}${version}`).toMatch(
				new RegExp(target.tag.pattern),
			);
		expect(transport.candidateDigest).toEqual({
			algorithm: "SHA-256",
			canonicalization: "RFC8785",
		});
		expect(transport.nativeTrustPolicy).toBe("unsigned-user-authorized");
		expect(transport.artifacts).toMatchObject({
			candidate: "ide-release-candidate-{orchestrationId}",
			assets: "ide-release-assets-{orchestrationId}",
		});
		expect(
			transport.platforms
				.flatMap((platform) => platform.installerRoster)
				.map((item) => item.logicalId)
				.sort(),
		).toEqual(["macos-arm64-dmg", "macos-x64-dmg", "windows-x64-nsis"]);
	});
});
