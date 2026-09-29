import type { bootstrapIdeApplication } from "../src/product/studio-composition";

// Compiled by the real IDE tsconfig; this fixture never creates a runtime host.
function assertProductHostContract(
	host: Awaited<ReturnType<typeof bootstrapIdeApplication>>["host"],
) {
	host.bus.emit("chat:pill", {
		pill: {
			kind: "file",
			display: "scene.ts",
			detail: "scene.ts",
			tooltip: { title: "File", lines: [] },
		},
	});
	// @ts-expect-error Product chat events require a structured pill payload.
	host.bus.emit("chat:pill", { pill: 42 });
	host.bus.emit("chat:pill", {
		pill: {
			// @ts-expect-error Product pills retain their closed kind vocabulary.
			kind: "unsupported",
			display: "",
			detail: "",
			tooltip: { title: "", lines: [] },
		},
	});
}
void assertProductHostContract;
