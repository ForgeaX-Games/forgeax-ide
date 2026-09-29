import contract from "../release/contract.json";

type Scope = keyof typeof contract.secretNames;

export function missingSecretNames(
	scope: Scope,
	env: Record<string, string | undefined>,
): string[] {
	return contract.secretNames[scope].filter((name) => !env[name]);
}

if (import.meta.main) {
	const index = Bun.argv.indexOf("--scope");
	const scope = Bun.argv[index + 1] as Scope;
	if (!(scope in contract.secretNames))
		throw new Error("valid release secret scope is required");
	const missing = missingSecretNames(scope, process.env);
	if (missing.length) {
		console.error(
			JSON.stringify({ code: "IDE_RELEASE_SECRETS_MISSING", scope, missing }),
		);
		process.exit(1);
	}
	console.log(
		JSON.stringify({
			code: "IDE_RELEASE_SECRET_CONTRACT_VALID",
			scope,
			count: contract.secretNames[scope].length,
		}),
	);
}
