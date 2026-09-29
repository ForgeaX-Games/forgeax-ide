import { expect, test } from "vitest";
import {
	configureStudioDomainClients,
	studioDomainClientRuntime,
} from "../src/product/product-clients";
import { ideRecentProjectsRuntime as runtime } from "../src/product/recent-projects-runtime";
import type {
	ProjectRow,
	StudioDomainClients,
} from "../src/product/shell-state-domain-contract";

test("recent projects preserve sort, failure, live clients and completion-order updates", async () => {
	const previous = studioDomainClientRuntime.read();
	let notifications = 0;
	const off = runtime.subscribe(() => {
		notifications++;
	});
	const configure = (
		listProjects: () => Promise<{
			games: ProjectRow[];
			activeSlug: string | null;
		}>,
	) =>
		configureStudioDomainClients({
			projects: { listProjects },
		} as StudioDomainClients);
	try {
		await runtime.warm();
		expect(runtime.getRevision()).toBe(0);
		const rows = Array.from({ length: 10 }, (_, i) => ({
			slug: String(i),
			mtime: i === 0 ? "invalid" : String(i),
		}));
		const order = rows.map((row) => row.slug);
		configure(async () => ({ games: rows, activeSlug: null }));
		await runtime.warm();
		expect(runtime.read().map((row) => row.slug)).toEqual([
			"9",
			"8",
			"7",
			"6",
			"5",
			"4",
			"3",
			"2",
		]);
		expect(rows.map((row) => row.slug)).toEqual(order);
		expect(runtime.read(20).at(-1)?.slug).toBe("0");
		expect(notifications).toBe(1);
		configure(async () => {
			throw new Error("offline");
		});
		await runtime.warm();
		expect(runtime.getRevision()).toBe(1);
		expect(runtime.read(1)[0]?.slug).toBe("9");
		const releases: Array<
			(value: { games: ProjectRow[]; activeSlug: string | null }) => void
		> = [];
		configure(
			() =>
				new Promise((resolve) => {
					releases.push(resolve);
				}),
		);
		const first = runtime.warm();
		const second = runtime.warm();
		expect(releases).toHaveLength(2);
		releases[1]!({ games: [{ slug: "second" }], activeSlug: null });
		await second;
		expect(runtime.read()[0]?.slug).toBe("second");
		releases[0]!({ games: [{ slug: "first" }], activeSlug: null });
		await first;
		expect(runtime.read()[0]?.slug).toBe("first");
		expect(runtime.getRevision()).toBe(3);
		off();
		configure(async () => ({ games: [], activeSlug: null }));
		await runtime.warm();
		expect(notifications).toBe(3);
		expect(runtime.read()).toEqual([]);
		expect(runtime.getRevision()).toBe(4);
	} finally {
		off();
		studioDomainClientRuntime.write(previous as StudioDomainClients);
	}
});
