import { studioDomainClientRuntime } from "./product-clients";
import type { ProjectRow } from "./shell-state-domain-contract";

let cache: ProjectRow[] = [];
let revision = 0;
const listeners = new Set<() => void>();

function read(limit = 8): ProjectRow[] {
	const mtime = (row: ProjectRow): number => {
		const value = Number(row.mtime);
		return Number.isFinite(value) ? value : 0;
	};
	return [...cache].sort((a, b) => mtime(b) - mtime(a)).slice(0, limit);
}

async function warm(): Promise<void> {
	const clients = studioDomainClientRuntime.read();
	if (!clients) return;
	try {
		const response = await clients.projects.listProjects();
		cache = response.games ?? [];
		revision += 1;
		listeners.forEach((listener) => {
			listener();
		});
	} catch {
		// Preserve the last successful snapshot on a transient failure.
	}
}

// The menu snapshot belongs to the page, across host disposal and recovery.
export const ideRecentProjectsRuntime = {
	read,
	warm,
	getRevision: (): number => revision,
	subscribe(listener: () => void): () => void {
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	},
};
