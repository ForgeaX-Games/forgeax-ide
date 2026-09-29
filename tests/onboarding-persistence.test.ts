import { describe, expect, test } from "vitest";
import {
	createOnboardingPersistence,
	ONBOARDING_STORAGE_KEYS,
} from "../src/integration/onboarding-persistence";

class MemoryStorage {
	readonly values = new Map<string, string>();

	getItem(key: string): string | null {
		return this.values.get(key) ?? null;
	}

	setItem(key: string, value: string): void {
		this.values.set(key, value);
	}
}

describe("IDE onboarding persistence integration", () => {
	test("returns an isolated default and normalizes the persisted v2 state", () => {
		const storage = new MemoryStorage();
		const persistence = createOnboardingPersistence(storage);

		const initial = persistence.loadOnboarding();
		initial.done.tour = true;
		expect(persistence.loadOnboarding()).toEqual({
			v: 2,
			phase: "welcome",
			done: { tour: false, firstChat: false },
		});

		storage.setItem(
			ONBOARDING_STORAGE_KEYS.onboarding,
			JSON.stringify({
				v: 2,
				phase: "home",
				done: { tour: 1, firstChat: 0 },
				ignored: true,
			}),
		);
		expect(persistence.loadOnboarding()).toEqual({
			v: 2,
			phase: "home",
			done: { tour: true, firstChat: false },
		});
	});

	test("migrates the legacy seen flag and keeps downgrade compatibility", () => {
		const storage = new MemoryStorage();
		storage.setItem(ONBOARDING_STORAGE_KEYS.onboardingSeenLegacy, "1");
		const persistence = createOnboardingPersistence(storage);

		const migrated = persistence.loadOnboarding();
		expect(migrated).toEqual({
			v: 2,
			phase: "done",
			done: { tour: true, firstChat: true },
		});
		expect(
			JSON.parse(storage.getItem(ONBOARDING_STORAGE_KEYS.onboarding) ?? ""),
		).toEqual(migrated);
		expect(storage.getItem(ONBOARDING_STORAGE_KEYS.onboardingSeenLegacy)).toBe(
			"1",
		);
	});

	test("falls back safely when storage reads or writes fail", () => {
		const storage = {
			getItem(): string | null {
				throw new Error("blocked");
			},
			setItem(): void {
				throw new Error("blocked");
			},
		};
		const persistence = createOnboardingPersistence(storage);

		expect(persistence.loadOnboarding()).toEqual({
			v: 2,
			phase: "welcome",
			done: { tour: false, firstChat: false },
		});
		expect(() =>
			persistence.saveOnboarding({
				v: 2,
				phase: "done",
				done: { tour: true, firstChat: true },
			}),
		).not.toThrow();
	});
});
