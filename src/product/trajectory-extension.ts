import type { AppExtension } from "@forgeax/app-shell/application";
import {
	registerAction,
	registerStateSlice,
} from "@forgeax/app-shell/application";
import { getIdeTrajectoryRuntime, TRAJECTORY_MAX } from "./trajectory-runtime";

const SNAPSHOT_TAIL = 20;

export const trajectoryExtension: AppExtension = {
	id: "trajectory",
	version: "1.0.0",
	setup() {
		const {
			read: readTrajectory,
			clear: clearTrajectory,
			start: startTrajectoryRecording,
		} = getIdeTrajectoryRuntime();
		const stopRecording = startTrajectoryRecording();

		const offSlice = registerStateSlice(
			"ui.trajectory",
			() => readTrajectory({ limit: SNAPSHOT_TAIL }).entries,
		);

		const offRead = registerAction({
			id: "trajectory.read",
			title: "读取操作轨迹",
			description:
				"Read the recent trajectory of UI operations performed on the page by BOTH the human and the AI, ordered oldest→newest. Every operation dispatched through the action registry is recorded (page mode switches, panel toggles, session/game/role/extension ops, etc.). Use this to understand what the user just did before asking you something. Params: limit (default 50, max " +
				TRAJECTORY_MAX +
				'), source ("human"|"ai" to filter by who performed it). Returns { total, count, entries:[{seq,ts,id,title,source,capability,args}] } in the result.',
			schema: {
				type: "object",
				properties: {
					limit: { type: "number" },
					source: { type: "string", enum: ["human", "ai"] },
				},
			},
			capability: "read",
			firstClass: true,
			surface: "ui",
			run: (args) => {
				const limit = typeof args.limit === "number" ? args.limit : undefined;
				const source =
					args.source === "human" || args.source === "ai"
						? args.source
						: undefined;
				return {
					status: "completed",
					stateDigest: readTrajectory({ limit, source }),
				};
			},
		});

		const offClear = registerAction({
			id: "trajectory.clear",
			title: "清空操作轨迹",
			description:
				"Clear the recorded UI operation trajectory buffer. Returns { cleared } — how many entries were removed.",
			capability: "write",
			surface: "ui",
			run: () => ({
				status: "completed",
				stateDigest: { cleared: clearTrajectory() },
			}),
		});

		return () => {
			stopRecording();
			offSlice();
			offRead();
			offClear();
		};
	},
};
