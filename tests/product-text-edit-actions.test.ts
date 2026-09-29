// @vitest-environment happy-dom
import { beforeEach, expect, test } from "vitest";
import {
	captureFocusedTextEditTarget,
	configureTextClipboard,
	executeFocusedTextEditAction,
} from "../src/product/text-edit-actions";

beforeEach(() => {
	document.body.replaceChildren();
	configureTextClipboard(null);
});

test("IDE edit commands preserve the focused input selection", async () => {
	const input = document.createElement("input");
	input.value = "hello world";
	document.body.append(input);
	input.focus();
	input.setSelectionRange(6, 11);
	let copied = "";
	configureTextClipboard({
		readText: async () => "Studio",
		writeText: async (value) => {
			copied = value;
		},
	});

	expect(await executeFocusedTextEditAction("copy")).toBe(true);
	expect(copied).toBe("world");
	expect(await executeFocusedTextEditAction("paste")).toBe(true);
	expect(input.value).toBe("hello Studio");
});

test("IDE edit commands restore a contenteditable selection after menu focus", async () => {
	const editor = document.createElement("div");
	editor.contentEditable = "true";
	editor.tabIndex = 0;
	editor.textContent = "selected text";
	const menu = document.createElement("button");
	document.body.append(editor, menu);
	editor.focus();
	const range = document.createRange();
	range.selectNodeContents(editor);
	const selection = document.getSelection();
	selection?.removeAllRanges();
	selection?.addRange(range);
	expect(captureFocusedTextEditTarget()).toBe(true);
	menu.focus();
	let copied = "";
	configureTextClipboard({
		readText: async () => "",
		writeText: async (value) => {
			copied = value;
		},
	});
	expect(await executeFocusedTextEditAction("copy")).toBe(true);
	expect(copied).toBe("selected text");
});
