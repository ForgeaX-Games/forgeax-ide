import type { ApplicationRuntimeOwner } from "@forgeax/app-shell/application";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import { IdeApplicationLifecycleBoundary as Boundary } from "../src/product/application-lifecycle-boundary";

vi.mock("../src/product/product-locale", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("../src/integration/error-reporting", () => ({ reportError: vi.fn() }));

function render(error: unknown, retryable = false, retrying = false): string {
	const snapshot = { status: "blocked" as const, error, retryable, retrying };
	const owner: ApplicationRuntimeOwner = {
		subscribe: () => () => {},
		getSnapshot: () => snapshot,
		acquire: vi.fn(),
		retryShutdown: vi.fn(),
	};
	return renderToStaticMarkup(
		<Boundary owner={owner}>Replacement must not render</Boundary>,
	);
}

test("unprintable cleanup errors preserve the recovery alert and reload exit", () => {
	for (const error of [
		Object.create(null),
		{
			toString() {
				throw new Error("conversion failed");
			},
		},
	]) {
		const html = render(error);
		expect(html).toContain('role="alert"');
		expect(html).toContain("Application shutdown failed");
		expect(html).toContain("errorBoundary.reloadStudio");
		expect(html).not.toContain("errorBoundary.retry");
		expect(html).not.toContain("Replacement must not render");
	}
});

test("hostile Error.message does not crash the outer recovery component", () => {
	const error = new Error("original");
	Object.defineProperty(error, "message", {
		get() {
			throw new Error("message failed");
		},
	});
	expect(render(error)).toContain("Application shutdown failed");
});

test("normal messages remain visible and only safe deferral exposes a retry", () => {
	const html = render(new Error("Waiting for owner"), true, true);
	expect(html).toContain("Waiting for owner");
	expect(html).toContain("errorBoundary.retry");
	expect(html).toContain('disabled=""');
	expect(html).toContain("errorBoundary.reloadStudio");
	expect(html).not.toContain("Replacement must not render");
});
