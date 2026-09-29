/** The product consumes the current window's optional, already initialized SDK.
 * SDK loading, credentials, auto-instrumentation and lifetime remain with its
 * installer. Reporting an error must not start telemetry or import a UI shell.
 */
interface ErrorReporter {
	error(payload: { msg: string; stack: string; componentStack: string }): void;
}

export function reportError(
	error: Error,
	componentStack?: string | null,
	scope?: string,
): void {
	try {
		if (typeof window === "undefined") return;
		// This is the SDK installer's existing published instance slot, not a new
		// singleton. Resolve at report time because the SDK loads asynchronously.
		const reporter = (window as Window & { __forgeaxAegis?: ErrorReporter })
			.__forgeaxAegis;
		if (!reporter) return;
		reporter.error({
			msg: `[${scope ?? "react"}] ${error.message}`,
			stack: error.stack ?? "",
			componentStack: componentStack ?? "",
		});
	} catch {
		// Telemetry must never replace the error that recovery is handling.
	}
}
