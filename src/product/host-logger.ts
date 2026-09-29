import type { ApplicationHostLogger } from "@forgeax/app-shell/application";

/** The IDE owns the logger supplied to its App Shell host and extension loader. */
export const ideHostLogger: ApplicationHostLogger = {
	debug: (message, ...rest) => console.debug(`[app-shell] ${message}`, ...rest),
	info: (message, ...rest) => console.info(`[app-shell] ${message}`, ...rest),
	warn: (message, ...rest) => console.warn(`[app-shell] ${message}`, ...rest),
	error: (message, ...rest) => console.error(`[app-shell] ${message}`, ...rest),
};
