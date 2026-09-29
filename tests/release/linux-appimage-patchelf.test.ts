import {
	chmodSync,
	copyFileSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { preserveExecutable } from "../../scripts/linux-appimage-patchelf";

test.skipIf(process.platform === "win32")(
	"preserves only byte-identical approved executables with system-only dependencies",
	() => {
		const root = mkdtempSync(join(tmpdir(), "appimage-elf-"));
		try {
			const source = join(root, "source");
			const target = join(root, "bun");
			const tool = join(root, "patchelf");
			writeFileSync(source, "approved executable");
			copyFileSync(source, target);
			writeFileSync(tool, '#!/bin/sh\nprintf "libc.so.6\\nlibm.so.6\\n"\n');
			chmodSync(tool, 0o755);
			const sources = [
				{ source, names: ["bun", "bun-x86_64-unknown-linux-gnu"] },
			];
			expect(
				preserveExecutable(
					["--set-rpath", "$ORIGIN/../lib", target],
					sources,
					tool,
				),
			).toBe(true);
			expect(preserveExecutable(["--print-rpath", target], sources, tool)).toBe(
				false,
			);
			expect(
				preserveExecutable(
					["--set-rpath", "$ORIGIN", join(root, "libsharp.so")],
					sources,
					tool,
				),
			).toBe(false);
			writeFileSync(target, "changed executable");
			expect(() =>
				preserveExecutable(["--set-rpath", "$ORIGIN", target], sources, tool),
			).toThrow("changed before ELF processing");
			copyFileSync(source, target);
			writeFileSync(tool, '#!/bin/sh\nprintf "libcustom.so\\n"\n');
			expect(() =>
				preserveExecutable(["--set-rpath", "$ORIGIN", target], sources, tool),
			).toThrow("non-system libraries");
			writeFileSync(tool, "#!/bin/sh\nexit 1\n");
			expect(() =>
				preserveExecutable(["--set-rpath", "$ORIGIN", target], sources, tool),
			).toThrow("cannot inspect");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
);
