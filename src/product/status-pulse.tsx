import {
	publishTopic,
	type StatusItemContribution,
} from "@forgeax/app-shell/application";
import {
	type ExtensionCountKind,
	useExtensionCounts,
} from "./extension-counts";
import { useTranslation } from "./product-locale";
import { useShellStore } from "./shell-state-runtime";

interface Pulse {
	id: string;
	kind: ExtensionCountKind;
	label: string;
	priority: number;
}
const PULSES: readonly Pulse[] = [
	{ id: "mb", kind: "model-binding", label: "MB", priority: 90 },
	{ id: "skill", kind: "skill", label: "SKILL", priority: 50 },
	{ id: "tool", kind: "tool", label: "TOOL", priority: 45 },
	{ id: "agent", kind: "agent", label: "AGENT", priority: 40 },
];

function StatusPulse({ pulse }: { pulse: Pulse }) {
	const { t } = useTranslation();
	const openOverlay = useShellStore((state) => state.openOverlay);
	const snapshot = useExtensionCounts();
	const row = snapshot.state === "ok" ? snapshot.value[pulse.kind] : undefined;
	const value = row ? String(row.count) : snapshot.state === "down" ? "!" : "—";
	const prefix = `pulse.${pulse.id}.title`;
	const title = row
		? row.count > 0
			? t(`${prefix}.some`, { count: String(row.count) }) +
				"\n" +
				row.ids.map((id) => `· ${id}`).join("\n")
			: t(`${prefix}.none`)
		: t(`${prefix}.${snapshot.state}`);
	return (
		<button
			type="button"
			className="sb-chip is-link"
			title={title}
			aria-label={`${pulse.label} ${value}`}
			onClick={() => {
				openOverlay("settings", "plugins");
				publishTopic("bus:filter-kind", pulse.kind, { retain: true });
			}}
		>
			<span className="sb-chip-label">{pulse.label}</span>
			<span className="sb-chip-value">{value}</span>
		</button>
	);
}

export const idePulseStatusItems: readonly StatusItemContribution[] =
	PULSES.map((pulse) => ({
		kind: "status-item",
		id: `bus.${pulse.id}`,
		location: "statusbar.right",
		priority: pulse.priority,
		item: { type: "custom", render: () => <StatusPulse pulse={pulse} /> },
	}));
