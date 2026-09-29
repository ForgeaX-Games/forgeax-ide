const PROVIDER_OVERRIDE_KEY = "forgeax.providerOverride";
const SETTINGS_SECTION_KEY = "forgeax.settingsSection";
const ACTIVE_SID_KEY = "forgeax.activeSid";
const AGENT_BY_SID_KEY = "forgeax.agentBySid";
const LEGACY_TABS_KEY = "forgeax.tabs";
const LEGACY_ACTIVE_TAB_KEY = "forgeax.activeTabId";

export function loadProviderOverride(): string | null {
	try {
		const v = localStorage.getItem(PROVIDER_OVERRIDE_KEY);
		return v && v !== "null" ? v : null;
	} catch {
		return null;
	}
}

export function saveProviderOverride(id: string | null): void {
	try {
		if (id === null) localStorage.removeItem(PROVIDER_OVERRIDE_KEY);
		else localStorage.setItem(PROVIDER_OVERRIDE_KEY, id);
	} catch {
		/* ignore (private mode / SSR) */
	}
}

export function loadSettingsSection(): string | null {
	try {
		const v = localStorage.getItem(SETTINGS_SECTION_KEY);
		return v && v.trim() ? v : null;
	} catch {
		return null;
	}
}

export function saveSettingsSection(id: string | null): void {
	try {
		if (id) localStorage.setItem(SETTINGS_SECTION_KEY, id);
		else localStorage.removeItem(SETTINGS_SECTION_KEY);
	} catch {
		/* ignore */
	}
}

export function cleanupLegacySessionKeys(): void {
	try {
		localStorage.removeItem(LEGACY_TABS_KEY);
		localStorage.removeItem(LEGACY_ACTIVE_TAB_KEY);
	} catch {
		/* ignore (private mode / SSR) */
	}
}

export function loadAgentBySid(): Record<string, string> {
	try {
		const raw = localStorage.getItem(AGENT_BY_SID_KEY);
		if (!raw) return {};
		const obj = JSON.parse(raw) as unknown;
		if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
		const out: Record<string, string> = {};
		for (const [sid, agent] of Object.entries(obj as Record<string, unknown>)) {
			if (
				typeof sid === "string" &&
				typeof agent === "string" &&
				sid &&
				agent
			) {
				out[sid] = agent;
			}
		}
		return out;
	} catch {
		return {};
	}
}

export function persistAgentBySid(map: Record<string, string>): void {
	try {
		localStorage.setItem(AGENT_BY_SID_KEY, JSON.stringify(map));
	} catch {
		/* ignore */
	}
}

export function loadActiveSid(): string | null {
	try {
		const v = localStorage.getItem(ACTIVE_SID_KEY);
		return v && v.trim() ? v : null;
	} catch {
		return null;
	}
}

export function persistActiveSid(sid: string | null): void {
	try {
		if (sid) localStorage.setItem(ACTIVE_SID_KEY, sid);
		else localStorage.removeItem(ACTIVE_SID_KEY);
	} catch {
		/* ignore */
	}
}
