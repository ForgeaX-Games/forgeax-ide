import { setTimeout as sleep } from "node:timers/promises";
import { initializeNativeWindowsJobEvidence } from "../../scripts/native-windows-job-evidence";

// bun:ffi initializes the real Windows Job in the runtime being tested.
const evidence = await initializeNativeWindowsJobEvidence();
if (!evidence) throw new Error("Windows Job evidence did not initialize");
const baseline = evidence.snapshot();
let stopGrandchild = false;
const control = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch: () => new Response(stopGrandchild ? "stop" : "wait"),
});
let grandchildPid = 0;
let observed = false;
let dirtyError = "";
try {
	const parent = Bun.spawn(
		[
			process.execPath,
			"-e",
			"const endpoint=process.argv[1];const child=Bun.spawn([process.execPath,'-e',`(async()=>{while(true){const response=await fetch(process.argv[1]);if(await response.text()==='stop')process.exit(0);await Bun.sleep(20)}})()`,endpoint],{stdin:'ignore',stdout:'ignore',stderr:'ignore',windowsHide:true});console.log(child.pid)",
			`http://127.0.0.1:${control.port}`,
		],
		{ stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true },
	);
	grandchildPid = Number((await new Response(parent.stdout).text()).trim());
	if ((await parent.exited) !== 0)
		throw new Error(await new Response(parent.stderr).text());
	if (!Number.isSafeInteger(grandchildPid) || grandchildPid <= 0)
		throw new Error("Invalid grandchild PID");
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		if (evidence.snapshot().some((value) => value.pid === grandchildPid)) {
			observed = true;
			break;
		}
		await sleep(50);
	}
	try {
		evidence.assertCleaned(baseline);
	} catch (error) {
		dirtyError = error instanceof Error ? error.message : String(error);
	}
} finally {
	stopGrandchild = true;
	try {
		const deadline = Date.now() + 5_000;
		while (
			Date.now() < deadline &&
			evidence.snapshot().some((value) => value.pid === grandchildPid)
		)
			await sleep(50);
	} finally {
		await control.stop(true);
	}
}
console.log(
	JSON.stringify({
		grandchildPid,
		observed,
		dirtyError,
		remaining: evidence.snapshot().some((value) => value.pid === grandchildPid),
	}),
);
