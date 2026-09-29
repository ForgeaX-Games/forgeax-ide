import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

// CI checkout adapters own authentication. Keep their Git helper/extraheader
// configuration intact; never extract credentials or persist new ones here.
export function materializeCiAppShell(root: string): string {
	const inputs = JSON.parse(
		readFileSync(
			join(root, "packages/ide/product/integration-inputs.json"),
			"utf8",
		),
	);
	const input = inputs?.appShell;
	if (
		inputs?.schemaVersion !== 1 ||
		input?.repository !== "ForgeaX-Games/forgeax-app-shell" ||
		typeof input?.revision !== "string" ||
		input.revision.length !== 40 ||
		!/^[a-f0-9]{40}$/.test(input.revision)
	)
		throw new Error(
			"IDE CI AppShell input must specify its canonical repository and immutable SHA",
		);
	const url = "https://github.com/ForgeaX-Games/forgeax-app-shell.git";
	const target = join(root, "packages/app-shell");
	const git = (cwd: string, ...args: string[]) =>
		execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "inherit"],
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
		}).trim();
	if (!existsSync(target)) {
		git(root, "clone", "--no-checkout", "--no-tags", url, target);
	} else {
		if (
			realpathSync(git(target, "rev-parse", "--show-toplevel")) !==
			realpathSync(target)
		)
			throw new Error("CI AppShell target must be its own Git checkout");
		if (git(target, "status", "--porcelain", "--untracked-files=all"))
			throw new Error("CI AppShell checkout must be clean");
	}
	git(target, "fetch", "--no-tags", url, input.revision);
	git(target, "checkout", "--detach", input.revision);
	const revision = git(target, "rev-parse", "HEAD");
	if (revision !== input.revision)
		throw new Error("CI AppShell revision mismatch");
	console.log(`[ci] AppShell ${revision}`);
	return revision;
}

if (import.meta.main)
	materializeCiAppShell(resolve(import.meta.dirname, "../../.."));
