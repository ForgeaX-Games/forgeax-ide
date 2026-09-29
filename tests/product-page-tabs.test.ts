import type { PageRegistrySnapshot } from "@forgeax/app-shell/pages";
import { describe, expect, it } from "vitest";
import { openablePageTypes } from "../src/product/page-tab-model";

describe("IDE new-page menu", () => {
	it("offers non-resource page types in title order", () => {
		const snapshot = {
			pageTypes: new Map([
				[
					"z",
					{
						status: "available",
						definition: { title: "Zeta", cardinality: "singleton" },
					},
				],
				[
					"a",
					{
						status: "available",
						definition: { title: "Alpha", cardinality: "multi-instance" },
					},
				],
				[
					"r",
					{
						status: "available",
						definition: { title: "Resource", cardinality: "resource" },
					},
				],
				[
					"u",
					{
						status: "unavailable",
						definition: { title: "Unavailable", cardinality: "singleton" },
					},
				],
			]),
		} as unknown as PageRegistrySnapshot;
		expect(openablePageTypes(snapshot).map(({ id }) => id)).toEqual(["a", "z"]);
	});
});
