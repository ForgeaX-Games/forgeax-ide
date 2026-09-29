import { test } from "vitest";
import {
	expectCodeContains,
	expectCodeNotContains,
} from "./code-token-assertions";

test("code token assertions ignore layout but preserve literal and identifier tokens", () => {
	expectCodeContains(
		'const value = "two words";',
		"const\nvalue = 'two words'",
	);
	expectCodeNotContains(
		'const value = "two words";',
		'const value = "twowords"',
	);
	expectCodeNotContains("const foobar = 1;", "const foo");
	expectCodeNotContains("const values = [,];", "const values = [];");
	expectCodeContains(
		"const path = `prefix-${name}`;\nconst next = true;",
		"const next = true",
	);
});
