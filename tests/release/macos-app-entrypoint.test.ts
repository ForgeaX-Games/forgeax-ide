import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { verifyApplicationExecutable } from "../../scripts/verify-macos-bundle";

test.skipIf(process.platform !== "darwin")(
	"rejects a guardian bundle and requires the actual IDE executable",
	() => {
		const app = mkdtempSync(join(tmpdir(), "ide-app-entry-"));
		try {
			mkdirSync(join(app, "Contents/MacOS"), { recursive: true });
			const plist = (name: string) =>
				writeFileSync(
					join(app, "Contents/Info.plist"),
					`<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>${name}</string></dict></plist>`,
				);
			writeFileSync(join(app, "Contents/MacOS/runtime-guardian"), "guardian");
			plist("runtime-guardian");
			expect(() => verifyApplicationExecutable(app)).toThrow(
				"invalid IDE executable",
			);
			plist("forgeax-ide-desktop");
			expect(() => verifyApplicationExecutable(app)).toThrow(
				"invalid IDE executable",
			);
			writeFileSync(join(app, "Contents/MacOS/forgeax-ide-desktop"), "IDE");
			expect(() => verifyApplicationExecutable(app)).not.toThrow();
		} finally {
			rmSync(app, { recursive: true, force: true });
		}
	},
);
