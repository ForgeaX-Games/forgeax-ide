import { existsSync, readdirSync } from "node:fs";
import { join, relative, win32 } from "node:path";

// MAX_PATH includes the trailing NUL. NSIS must therefore keep every emitted
// path below 260 characters on machines that have not opted into long paths.
export const WINDOWS_MAX_PATH = 260;
export const WINDOWS_PROFILE_DIRECTORY_BUDGET = 20;
const WINDOWS_PROFILE_PLACEHOLDER = "x".repeat(
	WINDOWS_PROFILE_DIRECTORY_BUDGET,
);
const WINDOWS_RELEASE_TEST_LOCAL_APP_DATA = win32.join(
	"C:\\Users",
	WINDOWS_PROFILE_PLACEHOLDER,
	"AppData",
	"Local",
);

function filesUnder(root: string): string[] {
	if (!existsSync(root)) return [];
	const files: string[] = [];
	const visit = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) visit(path);
			else if (entry.isFile()) files.push(path);
		}
	};
	visit(root);
	return files;
}

export function defaultWindowsInstallResourceRoot(
	localAppData = process.env.LOCALAPPDATA,
): string {
	if (!localAppData)
		throw new Error(
			"LOCALAPPDATA is required to validate the Windows install path",
		);
	return win32.join(localAppData, "ForgeaX Studio", "resources");
}

export function releaseTestWindowsInstallResourceRoot(
	localAppData = process.env.LOCALAPPDATA,
): string {
	const actual = localAppData
		? defaultWindowsInstallResourceRoot(localAppData)
		: "";
	const supported = defaultWindowsInstallResourceRoot(
		WINDOWS_RELEASE_TEST_LOCAL_APP_DATA,
	);
	return actual.length > supported.length ? actual : supported;
}

export function windowsInstallResourcePathViolations(
	resourceRoot: string,
	installResourceRoot = releaseTestWindowsInstallResourceRoot(),
): Array<{ path: string; installPath: string; length: number }> {
	return filesUnder(resourceRoot)
		.map((source) => {
			const path = relative(resourceRoot, source);
			const installPath = win32.join(
				installResourceRoot,
				...path.split(/[\\/]/u),
			);
			return { path, installPath, length: installPath.length };
		})
		.filter(({ length }) => length >= WINDOWS_MAX_PATH)
		.sort(
			(left, right) =>
				right.length - left.length || left.path.localeCompare(right.path),
		);
}
