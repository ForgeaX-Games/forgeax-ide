export const platformTargets = {
	"macos-arm64": {
		os: "darwin",
		arch: "arm64",
		triple: "aarch64-apple-darwin",
		extension: "",
	},
	"macos-x64": {
		os: "darwin",
		arch: "x64",
		triple: "x86_64-apple-darwin",
		extension: "",
	},
	"windows-x64": {
		os: "win32",
		arch: "x64",
		triple: "x86_64-pc-windows-msvc",
		extension: ".exe",
	},
	"linux-x64": {
		os: "linux",
		arch: "x64",
		triple: "x86_64-unknown-linux-gnu",
		extension: "",
	},
} as const;
export type DesktopPlatform = keyof typeof platformTargets;
