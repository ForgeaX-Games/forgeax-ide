import { describe, expect, it } from "vitest";
import {
	buildProductRuntimeReport,
	type RuntimeComponent,
} from "../../src/runtime/product-runtime-report";

const component = (
	id: string,
	required: boolean,
	status: RuntimeComponent["status"],
): RuntimeComponent => ({
	kind: "extension",
	id,
	version: "0.1.0",
	required,
	status,
	phase: "activate",
});

describe("ProductRuntimeReportV1 contract", () => {
	it("marks all-ready products as product-ready", () =>
		expect(
			buildProductRuntimeReport([component("agent", true, "ready")]).status,
		).toBe("product-ready"));
	it("does not hide required failures", () => {
		const report = buildProductRuntimeReport([
			component("agent", true, "failed"),
		]);
		expect(report.status).toBe("failed");
		expect(report.diagnostics[0]).toMatchObject({
			code: "IDE_REQUIRED_COMPONENT_FAILED",
			phase: "activate",
			component: "agent",
		});
	});
	it("degrades for optional failures while retaining recovery actions", () => {
		const report = buildProductRuntimeReport([
			component("agent", true, "ready"),
			component("preview", false, "failed"),
		]);
		expect(report.status).toBe("degraded");
		expect(report.diagnostics[0].recoveryActions.length).toBeGreaterThan(0);
	});
});
