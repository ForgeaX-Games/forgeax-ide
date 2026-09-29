import {
	type ApplicationRuntime,
	type ApplicationShortcut,
	ApplicationStartupCleanupError,
} from "@forgeax/app-shell/application";
import { createIdeComposerInsertRuntime } from "../integration/composer-reference-queue";
import { createIdeShellShortcutFactory } from "../integration/product-shortcuts";
import { bootIdeAppMounted } from "./boot-progress";
import {
	changeLanguage,
	createIdeLocaleRuntime,
	initI18n,
	type Locale,
	t,
} from "./product-locale";

const createIdeShellShortcuts = createIdeShellShortcutFactory(t);
export interface IdeApplicationStartupOptions {
	readonly createShellShortcuts?: typeof createIdeShellShortcuts;
	readonly locale?: Locale;
}
export interface IdeApplicationBindings {
	configureLocaleRuntime(factory: typeof createIdeLocaleRuntime): void;
	configureComposerInsertRuntime(
		factory: typeof createIdeComposerInsertRuntime,
	): void;
	toggleCommandPalette(): void;
}
export type IdeApplicationRuntime<Runtime extends ApplicationRuntime> =
	Runtime & {
		readonly shellShortcuts?: readonly ApplicationShortcut[];
	};

/** Product startup and failure ownership, above replaceable shell rendering.
 * Product composition owns builtin selection and catalog/host lifetime; concrete
 * builtin, catalog adapter and host implementations remain compatibility inputs. */
export async function startIdeApplication<Runtime extends ApplicationRuntime>(
	bootstrap: () => Promise<Runtime>,
	bindings: IdeApplicationBindings,
	options: IdeApplicationStartupOptions = {},
): Promise<IdeApplicationRuntime<Runtime>> {
	bindings.configureLocaleRuntime(createIdeLocaleRuntime);
	initI18n();
	if (options.locale !== undefined) changeLanguage(options.locale);
	bindings.configureComposerInsertRuntime(createIdeComposerInsertRuntime);
	const runtime = await bootstrap();
	try {
		const shellShortcuts = (
			options.createShellShortcuts ?? createIdeShellShortcuts
		)({
			host: runtime.host,
			toggleCommandPalette: bindings.toggleCommandPalette,
		});
		const started = Object.assign(runtime, { shellShortcuts });
		bootIdeAppMounted();
		return started;
	} catch (error) {
		try {
			await runtime.dispose();
		} catch (cleanupError) {
			throw new ApplicationStartupCleanupError(error, runtime, cleanupError);
		}
		throw error;
	}
}
