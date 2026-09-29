import type { IdeShellStoreContext } from "./shell-state-context";
import type {
	AppState,
	ConsoleEntry,
	NetworkEntry,
	TelemetryRecord,
} from "./shell-state-contract";

type SetAppState = (
	partial: Partial<AppState> | ((state: AppState) => Partial<AppState>),
) => void;

export function createObservabilityState(
	set: SetAppState,
	recordLog: IdeShellStoreContext["recordLog"],
): Pick<
	AppState,
	| "consoleLog"
	| "pushConsole"
	| "clearConsole"
	| "networkLog"
	| "pushNetwork"
	| "clearNetwork"
	| "telemetry"
	| "pushTelemetry"
	| "clearTelemetry"
> {
	return {
		consoleLog: [],
		pushConsole: (entry: ConsoleEntry) => {
			recordLog("console", entry);
			set((s) => ({
				consoleLog:
					s.consoleLog.length >= 500
						? [...s.consoleLog.slice(s.consoleLog.length - 499), entry]
						: [...s.consoleLog, entry],
			}));
		},
		clearConsole: () => set({ consoleLog: [] }),

		networkLog: [],
		pushNetwork: (entry: NetworkEntry) => {
			recordLog("network", entry);
			set((s) => ({
				networkLog:
					s.networkLog.length >= 500
						? [...s.networkLog.slice(s.networkLog.length - 499), entry]
						: [...s.networkLog, entry],
			}));
		},
		clearNetwork: () => set({ networkLog: [] }),

		telemetry: [],
		pushTelemetry: (records: TelemetryRecord[]) => {
			if (!records.length) return;
			set((s) => {
				const next = [...s.telemetry, ...records];
				return {
					telemetry: next.length > 500 ? next.slice(next.length - 500) : next,
				};
			});
		},
		clearTelemetry: () => set({ telemetry: [] }),
	};
}
