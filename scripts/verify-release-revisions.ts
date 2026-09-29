import { spawnSync } from "node:child_process";

const sha = /^[0-9a-f]{40}$/;
export type RevisionInput = {
	name: string;
	directory: string;
	expected: string;
	branch: string;
};

function git(directory: string, args: string[]): string {
	const result = spawnSync("git", ["-C", directory, ...args], {
		encoding: "utf8",
	});
	if (result.status !== 0)
		throw new Error(
			`${args.join(" ")} failed for ${directory}: ${result.stderr.trim().slice(0, 300)}`,
		);
	return result.stdout.trim();
}

export function validateRevisionShape(
	input: Pick<RevisionInput, "name" | "expected">,
): void {
	if (!sha.test(input.expected))
		throw new Error(`${input.name} revision must be an exact 40-character SHA`);
}

export function verifyReleaseRevision(input: RevisionInput): {
	name: string;
	commit: string;
	tree: string;
} {
	validateRevisionShape(input);
	if (!/^(?:main|release\d{8})$/.test(input.branch))
		throw new Error(`${input.name} revision branch is invalid`);
	const actual = git(input.directory, ["rev-parse", "HEAD"]);
	if (actual !== input.expected)
		throw new Error(`${input.name} checkout does not match requested revision`);
	const branchRef = `refs/remotes/origin/${input.branch}`;
	git(input.directory, ["rev-parse", "--verify", branchRef]);
	const reachable = spawnSync("git", [
		"-C",
		input.directory,
		"merge-base",
		"--is-ancestor",
		actual,
		branchRef,
	]);
	if (reachable.status !== 0)
		throw new Error(
			`${input.name} revision is not reachable from origin/${input.branch}`,
		);
	return {
		name: input.name,
		commit: actual,
		tree: git(input.directory, ["rev-parse", "HEAD^{tree}"]),
	};
}

if (import.meta.main) {
	const required = (name: string): string => {
		const value = process.env[name];
		if (!value) throw new Error(`${name} is required`);
		return value;
	};
	const branch = required("REVISION_BRANCH");
	const sources = [
		verifyReleaseRevision({
			name: "forgeax-ide",
			directory: required("FORGEAX_IDE_ROOT"),
			expected: required("IDE_REVISION"),
			branch,
		}),
		verifyReleaseRevision({
			name: "forgeax-studio",
			directory: required("FORGEAX_INTEGRATION_ROOT"),
			expected: required("INTEGRATION_REVISION"),
			branch,
		}),
	];
	console.log(JSON.stringify({ code: "IDE_RELEASE_REVISIONS_VALID", sources }));
}
