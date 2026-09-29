export type OnboardingPhase = "welcome" | "project" | "home" | "done";

export interface OnboardingPersisted {
	v: 2;
	phase: OnboardingPhase;
	done: {
		tour: boolean;
		firstChat: boolean;
	};
}

export interface OnboardingStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

export const ONBOARDING_STORAGE_KEYS = {
	onboarding: "forgeax.onboarding.v2",
	onboardingSeenLegacy: "forgeax.onboarding.seen",
} as const;

const DEFAULT_STATE: OnboardingPersisted = {
	v: 2,
	phase: "welcome",
	done: { tour: false, firstChat: false },
};

function defaultState(): OnboardingPersisted {
	return { ...DEFAULT_STATE, done: { ...DEFAULT_STATE.done } };
}

export function createOnboardingPersistence(storage: OnboardingStorage): {
	loadOnboarding(): OnboardingPersisted;
	saveOnboarding(state: OnboardingPersisted): void;
} {
	function saveOnboarding(state: OnboardingPersisted): void {
		try {
			storage.setItem(
				ONBOARDING_STORAGE_KEYS.onboarding,
				JSON.stringify(state),
			);
			if (state.phase === "done") {
				storage.setItem(ONBOARDING_STORAGE_KEYS.onboardingSeenLegacy, "1");
			}
		} catch {
			// Storage can be blocked or unavailable. Onboarding remains ephemeral.
		}
	}

	function loadOnboarding(): OnboardingPersisted {
		try {
			const raw = storage.getItem(ONBOARDING_STORAGE_KEYS.onboarding);
			if (raw) {
				const parsed = JSON.parse(raw) as Partial<OnboardingPersisted>;
				if (parsed && parsed.v === 2 && parsed.phase) {
					return {
						v: 2,
						phase: parsed.phase,
						done: {
							tour: !!parsed.done?.tour,
							firstChat: !!parsed.done?.firstChat,
						},
					};
				}
			}

			if (storage.getItem(ONBOARDING_STORAGE_KEYS.onboardingSeenLegacy)) {
				const migrated: OnboardingPersisted = {
					v: 2,
					phase: "done",
					done: { tour: true, firstChat: true },
				};
				saveOnboarding(migrated);
				return migrated;
			}
		} catch {
			// Corrupt or unavailable storage falls back to a fresh state.
		}
		return defaultState();
	}

	return { loadOnboarding, saveOnboarding };
}

export function loadOnboarding(): OnboardingPersisted {
	try {
		return createOnboardingPersistence(
			globalThis.localStorage,
		).loadOnboarding();
	} catch {
		return defaultState();
	}
}

export function saveOnboarding(state: OnboardingPersisted): void {
	try {
		createOnboardingPersistence(globalThis.localStorage).saveOnboarding(state);
	} catch {
		// Storage can be absent in non-browser runtimes.
	}
}
