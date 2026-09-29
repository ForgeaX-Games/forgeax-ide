export type TextEditAction = "cut" | "copy" | "paste" | "selectAll";

export interface TextClipboard {
	readText(): Promise<string>;
	writeText(text: string): Promise<void>;
}

let configuredTextClipboard: TextClipboard | undefined;

/** Desktop hosts (Tauri) supply a native clipboard; web uses `navigator.clipboard`. */
export function configureTextClipboard(clipboard: TextClipboard | null): void {
	configuredTextClipboard = clipboard ?? undefined;
}

function resolveTextClipboard(
	explicit: TextClipboard | undefined,
): TextClipboard | undefined {
	if (explicit !== undefined) return explicit;
	if (configuredTextClipboard) return configuredTextClipboard;
	if (typeof navigator !== "undefined" && navigator.clipboard) {
		return navigator.clipboard;
	}
	return undefined;
}

export type NativeTextEditTarget = HTMLInputElement | HTMLTextAreaElement;
export type TextEditTarget = NativeTextEditTarget | HTMLElement;

interface CapturedTextEditTarget {
	readonly target: TextEditTarget;
	readonly selectionStart?: number | null;
	readonly selectionEnd?: number | null;
	readonly range?: Range;
}

const capturedTargets = new WeakMap<Document, CapturedTextEditTarget>();

const NON_TEXT_INPUT_TYPES = new Set([
	"button",
	"checkbox",
	"color",
	"file",
	"hidden",
	"image",
	"radio",
	"range",
	"reset",
	"submit",
]);

export function textEditTargetFrom(
	target: EventTarget | null,
): TextEditTarget | null {
	if (!(target instanceof Element)) return null;
	const candidate =
		target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
			? target
			: target.closest("input, textarea");
	if (candidate instanceof HTMLTextAreaElement) return candidate;
	if (
		candidate instanceof HTMLInputElement &&
		!NON_TEXT_INPUT_TYPES.has(candidate.type)
	)
		return candidate;
	const editable = target.closest<HTMLElement>(
		'[contenteditable]:not([contenteditable="false"])',
	);
	return editable instanceof HTMLElement ? editable : null;
}

export function selectedText(target: TextEditTarget): string {
	if (
		!(target instanceof HTMLInputElement) &&
		!(target instanceof HTMLTextAreaElement)
	) {
		const selection = target.ownerDocument.getSelection();
		if (!selection || selection.rangeCount === 0) return "";
		const range = selection.getRangeAt(0);
		return rangeBelongsTo(range, target) ? selection.toString() : "";
	}
	const start = target.selectionStart;
	const end = target.selectionEnd;
	return typeof start === "number" && typeof end === "number"
		? target.value.slice(start, end)
		: "";
}

function setNativeValue(target: NativeTextEditTarget, value: string): void {
	const prototype =
		target instanceof HTMLTextAreaElement
			? HTMLTextAreaElement.prototype
			: HTMLInputElement.prototype;
	const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
	if (setter) setter.call(target, value);
	else target.value = value;
}

function replaceNativeSelection(
	target: NativeTextEditTarget,
	inserted: string,
): void {
	const start = target.selectionStart ?? target.value.length;
	const end = target.selectionEnd ?? target.value.length;
	const nextValue =
		target.value.slice(0, start) + inserted + target.value.slice(end);
	setNativeValue(target, nextValue);
	const caret = start + inserted.length;
	try {
		target.setSelectionRange(caret, caret);
	} catch {
		/* unsupported input type */
	}
	target.dispatchEvent(new Event("input", { bubbles: true }));
	target.focus();
}

function rangeBelongsTo(range: Range, target: HTMLElement): boolean {
	const container = range.commonAncestorContainer;
	return container === target || target.contains(container);
}

function selectionRangeFor(target: HTMLElement): Range {
	const ownerDocument = target.ownerDocument;
	const selection = ownerDocument.getSelection();
	if (selection && selection.rangeCount > 0) {
		const current = selection.getRangeAt(0);
		if (rangeBelongsTo(current, target)) return current;
	}
	const range = ownerDocument.createRange();
	range.selectNodeContents(target);
	range.collapse(false);
	return range;
}

function replaceContentEditableSelection(
	target: HTMLElement,
	inserted: string,
): void {
	target.focus();
	const selection = target.ownerDocument.getSelection();
	const range = selectionRangeFor(target);
	range.deleteContents();
	if (inserted.length > 0) {
		const text = target.ownerDocument.createTextNode(inserted);
		range.insertNode(text);
		range.setStartAfter(text);
	}
	range.collapse(true);
	selection?.removeAllRanges();
	selection?.addRange(range);
	target.dispatchEvent(new Event("input", { bubbles: true }));
}

function replaceSelection(target: TextEditTarget, inserted: string): void {
	if (
		target instanceof HTMLInputElement ||
		target instanceof HTMLTextAreaElement
	) {
		replaceNativeSelection(target, inserted);
		return;
	}
	replaceContentEditableSelection(target, inserted);
}

function selectAllText(target: TextEditTarget): void {
	target.focus();
	if (
		target instanceof HTMLInputElement ||
		target instanceof HTMLTextAreaElement
	) {
		try {
			target.setSelectionRange(0, target.value.length);
		} catch {
			target.select();
		}
		return;
	}
	const selection = target.ownerDocument.getSelection();
	const range = target.ownerDocument.createRange();
	range.selectNodeContents(target);
	selection?.removeAllRanges();
	selection?.addRange(range);
}

function captureTarget(target: TextEditTarget): CapturedTextEditTarget {
	if (
		target instanceof HTMLInputElement ||
		target instanceof HTMLTextAreaElement
	) {
		return {
			target,
			selectionStart: target.selectionStart,
			selectionEnd: target.selectionEnd,
		};
	}
	const selection = target.ownerDocument.getSelection();
	const range =
		selection &&
		selection.rangeCount > 0 &&
		rangeBelongsTo(selection.getRangeAt(0), target)
			? selection.getRangeAt(0).cloneRange()
			: undefined;
	return { target, range };
}

function restoreTarget(
	captured: CapturedTextEditTarget,
): TextEditTarget | null {
	const { target } = captured;
	if (!target.isConnected) return null;
	target.focus();
	if (
		target instanceof HTMLInputElement ||
		target instanceof HTMLTextAreaElement
	) {
		if (
			typeof captured.selectionStart === "number" &&
			typeof captured.selectionEnd === "number"
		) {
			try {
				target.setSelectionRange(
					captured.selectionStart,
					captured.selectionEnd,
				);
			} catch {
				/* unsupported input type */
			}
		}
		return target;
	}
	if (captured.range) {
		const selection = target.ownerDocument.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(captured.range);
	}
	return target;
}

/** Preserve the focused editor before a web menu moves DOM focus into its
 * portalled menu surface. The next text command consumes this snapshot. */
export function captureFocusedTextEditTarget(
	ownerDocument: Document = document,
): boolean {
	const target = textEditTargetFrom(ownerDocument.activeElement);
	if (!target) {
		capturedTargets.delete(ownerDocument);
		return false;
	}
	capturedTargets.set(ownerDocument, captureTarget(target));
	return true;
}

export async function executeTextEditAction(
	action: TextEditAction,
	target: TextEditTarget,
	clipboard?: TextClipboard,
): Promise<boolean> {
	if (action === "selectAll") {
		selectAllText(target);
		return true;
	}

	const resolved = resolveTextClipboard(clipboard);
	if (!resolved) return false;
	if (action === "copy") {
		await resolved.writeText(selectedText(target));
		return true;
	}
	if (action === "cut") {
		await resolved.writeText(selectedText(target));
		replaceSelection(target, "");
		return true;
	}

	replaceSelection(target, await resolved.readText());
	return true;
}

export async function executeFocusedTextEditAction(
	action: TextEditAction,
	ownerDocument: Document = document,
	clipboard?: TextClipboard,
): Promise<boolean> {
	const activeTarget = textEditTargetFrom(ownerDocument.activeElement);
	const captured = activeTarget
		? undefined
		: capturedTargets.get(ownerDocument);
	if (captured) capturedTargets.delete(ownerDocument);
	const target = activeTarget ?? (captured ? restoreTarget(captured) : null);
	return target ? executeTextEditAction(action, target, clipboard) : false;
}
