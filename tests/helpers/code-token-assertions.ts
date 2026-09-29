import {
	createScanner,
	LanguageVariant,
	ScriptTarget,
	SyntaxKind,
} from "typescript";
import { expect } from "vitest";

function tokenizeCode(source: string): string[] {
	const scanner = createScanner(
		ScriptTarget.Latest,
		true,
		LanguageVariant.Standard,
		source,
	);
	const tokens: string[] = [];
	const templateBraceDepth: number[] = [];
	let rescanTemplate = false;
	while (true) {
		const kind = rescanTemplate
			? scanner.reScanTemplateToken(false)
			: scanner.scan();
		rescanTemplate = false;
		if (kind === SyntaxKind.EndOfFileToken) break;
		if (kind === SyntaxKind.StringLiteral)
			tokens.push(`string:${scanner.getTokenValue()}`);
		else tokens.push(`token:${scanner.getTokenText()}`);
		if (kind === SyntaxKind.TemplateHead) templateBraceDepth.push(0);
		else if (kind === SyntaxKind.OpenBraceToken && templateBraceDepth.length)
			templateBraceDepth[templateBraceDepth.length - 1] += 1;
		else if (kind === SyntaxKind.CloseBraceToken && templateBraceDepth.length) {
			const index = templateBraceDepth.length - 1;
			if (templateBraceDepth[index] > 0) templateBraceDepth[index] -= 1;
			else rescanTemplate = true;
		} else if (kind === SyntaxKind.TemplateTail) templateBraceDepth.pop();
	}
	return tokens.filter(
		(token, index) =>
			token !== "token:," ||
			!["token:}", "token:]", "token:)"].includes(tokens[index + 1] ?? "") ||
			(tokens[index + 1] === "token:]" &&
				["token:[", "token:,"].includes(tokens[index - 1] ?? "")),
	);
}

function containsCode(source: string, fragment: string): boolean {
	const sourceTokens = tokenizeCode(source);
	const fragmentTokens = tokenizeCode(fragment);
	if (fragmentTokens.length === 0) return true;
	return sourceTokens.some((_, start) =>
		fragmentTokens.every(
			(token, offset) => sourceTokens[start + offset] === token,
		),
	);
}

/** Assert a source contract without coupling it to whitespace or quote style. */
export function expectCodeContains(source: string, fragment: string): void {
	expect(containsCode(source, fragment)).toBe(true);
}

/** Assert that a source contract is absent without coupling it to formatting. */
export function expectCodeNotContains(source: string, fragment: string): void {
	expect(containsCode(source, fragment)).toBe(false);
}
