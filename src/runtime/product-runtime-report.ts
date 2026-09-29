export type RuntimeComponentKind = "extension" | "service";
export type RuntimeComponentStatus = "ready" | "degraded" | "failed";
export type RuntimeComponent = {
	kind: RuntimeComponentKind;
	id: string;
	version: string;
	required: boolean;
	status: RuntimeComponentStatus;
	phase: string;
};
export type ProductRuntimeDiagnostic = {
	code: string;
	phase: string;
	component: string;
	hint: string;
	expected?: string;
	actual?: string;
	retryable: boolean;
	recoveryActions: string[];
};
export type ProductRuntimeReportV1 = {
	schemaVersion: 1;
	status: "product-ready" | "degraded" | "failed";
	components: RuntimeComponent[];
	diagnostics: ProductRuntimeDiagnostic[];
};

export function buildProductRuntimeReport(
	components: RuntimeComponent[],
): ProductRuntimeReportV1 {
	const failed = components.filter(
		(component) => component.status === "failed",
	);
	const requiredFailure = failed.find((component) => component.required);
	return {
		schemaVersion: 1,
		status: requiredFailure
			? "failed"
			: failed.length
				? "degraded"
				: "product-ready",
		components,
		diagnostics: failed.map((component) => ({
			code: component.required
				? "IDE_REQUIRED_COMPONENT_FAILED"
				: "IDE_OPTIONAL_COMPONENT_FAILED",
			phase: component.phase,
			component: component.id,
			hint: "Restore the locked release artifact and retry activation.",
			expected: component.version,
			actual: component.status,
			retryable: !component.required,
			recoveryActions: ["restore-locked-artifact", "retry-activation"],
		})),
	};
}
