/** CommandPalette —— cmdk 命令面板(P2-15,激活死依赖)。
 *
 *  数据源 = ActionRegistry(与按钮 / AI 同一张注册表,压缩公理:一表三消费者)。
 *  执行走 `dispatchAction` 单入口(source:'human')。Ctrl/⌘+K 开合。
 *
 *  两段式(P2-16):选中带参数的 action 不再盲发空参被静默拒,而是进「参数引导」
 *  子界面——用 action 的 description 作使用说明,按 schema 逐字段给输入(enum 下拉 /
 *  布尔 / 数字 / 文本),提交后校验通过再派发。无参 action 直接执行。任何结果
 *  (完成 / 受理 / 被拒原因)都在面板内回显,不再「点了没反应」。
 */

import {
	dispatchAction,
	getAction,
	snapshotActions,
	type UiActionDef,
	type UiActionSummary,
} from "@forgeax/app-shell/application";
import { createRestartableTimeoutTaskLifecycle } from "@forgeax/app-shell/react";
import { Command } from "cmdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	setIdeCommandPaletteOpen,
	useIdeCommandPaletteOpen,
} from "./command-palette-store";
import "./command-palette.css";

interface ParamSpec {
	key: string;
	type?: string;
	enum?: unknown[];
	description?: string;
	required: boolean;
}

/** 从 action 的 JSON Schema 派生顶层参数清单(与 registry 的 validateArgs 同口径)。 */
function paramsOf(def: UiActionDef): ParamSpec[] {
	const schema = def.schema;
	if (!schema || typeof schema !== "object") return [];
	const props =
		schema.properties && typeof schema.properties === "object"
			? (schema.properties as Record<
					string,
					{ type?: unknown; enum?: unknown[]; description?: unknown }
				>)
			: {};
	const required = new Set(
		Array.isArray(schema.required)
			? (schema.required as unknown[]).filter(
					(k): k is string => typeof k === "string",
				)
			: [],
	);
	return Object.entries(props).map(([key, p]) => ({
		key,
		type: typeof p?.type === "string" ? p.type : undefined,
		enum: Array.isArray(p?.enum) ? p.enum : undefined,
		description: typeof p?.description === "string" ? p.description : undefined,
		required: required.has(key),
	}));
}

/** 把表单里的字符串按声明类型转回 JS 值(布尔 / 数字 / JSON),供派发。 */
function coerce(
	raw: string,
	type?: string,
): { ok: true; value: unknown } | { ok: false; err: string } {
	if (type === "number" || type === "integer") {
		const n = Number(raw);
		if (raw.trim() === "" || Number.isNaN(n))
			return { ok: false, err: "需要数字" };
		if (type === "integer" && !Number.isInteger(n))
			return { ok: false, err: "需要整数" };
		return { ok: true, value: n };
	}
	if (type === "boolean") return { ok: true, value: raw === "true" };
	if (type === "object" || type === "array") {
		try {
			return { ok: true, value: JSON.parse(raw) };
		} catch {
			return { ok: false, err: "需要合法 JSON" };
		}
	}
	return { ok: true, value: raw };
}

function typeHint(p: ParamSpec): string {
	const bits: string[] = [];
	if (p.enum?.length) bits.push(`可选:${p.enum.map(String).join(" / ")}`);
	else if (p.type) bits.push(p.type);
	bits.push(p.required ? "必填" : "可选");
	return bits.join(" · ");
}

type Feedback = { kind: "ok" | "err"; text: string } | null;

export function IdeCommandPalette() {
	const open = useIdeCommandPaletteOpen();
	const [rows, setRows] = useState<UiActionSummary[]>([]);
	const [formDef, setFormDef] = useState<UiActionDef | null>(null); // 非空 = 处于参数引导子界面
	const [values, setValues] = useState<Record<string, string>>({});
	const [feedback, setFeedback] = useState<Feedback>(null);
	// 动态候选:paramKey → 取值列表(undefined=还在解析,[]=解析完但无项)。
	const [choices, setChoices] = useState<Record<string, string[] | undefined>>(
		{},
	);
	const firstFieldRef = useRef<HTMLElement | null>(null);
	const closeTask = useRef<ReturnType<
		typeof createRestartableTimeoutTaskLifecycle
	> | null>(null);

	const close = useCallback(() => {
		closeTask.current?.cancel();
		setIdeCommandPaletteOpen(false);
		setFormDef(null);
		setValues({});
		setFeedback(null);
	}, []);

	// 成功后不立刻关:先让绿色回报(含 stateDigest,如 console.clear 的 {cleared:N})显示一下再自动关。
	const scheduleClose = useCallback(() => {
		closeTask.current?.schedule();
	}, []);

	useEffect(() => {
		const task = createRestartableTimeoutTaskLifecycle({
			delayMs: 1100,
			task: close,
		});
		closeTask.current = task;
		return () => {
			task.dispose();
			closeTask.current = null;
		};
	}, [close]);

	// 打开时取一次注册表快照;available 的排前面。
	useEffect(() => {
		if (!open) return;
		const snap = snapshotActions();
		snap.sort(
			(a, b) =>
				Number(b.available) - Number(a.available) ||
				a.title.localeCompare(b.title),
		);
		setRows(snap);
	}, [open]);

	// 进入参数界面:解析动态候选(choices),就绪后把候选字段默认选到第一项,并聚焦首字段。
	useEffect(() => {
		if (!formDef) {
			setChoices({});
			return;
		}
		firstFieldRef.current?.focus();
		const provs = formDef.choices ?? {};
		const keys = Object.keys(provs);
		if (keys.length === 0) return;
		let cancelled = false;
		void (async () => {
			const resolved: Record<string, string[]> = {};
			await Promise.all(
				keys.map(async (k) => {
					try {
						resolved[k] = (await provs[k]()) ?? [];
					} catch {
						resolved[k] = [];
					}
				}),
			);
			if (cancelled) return;
			setChoices(resolved);
			setValues((v) => {
				const next = { ...v };
				for (const k of keys)
					if (resolved[k]?.length && !next[k]) next[k] = resolved[k][0];
				return next;
			});
		})();
		return () => {
			cancelled = true;
		};
	}, [formDef]);

	/** 真正派发 + 结果回显。成功(完成/受理)返回 true,被拒返回 false。 */
	const execute = useCallback(
		async (id: string, args: Record<string, unknown>): Promise<boolean> => {
			const res = await dispatchAction(id, args, { source: "human" });
			if (res.status === "rejected") {
				setFeedback({ kind: "err", text: res.reason ?? "执行被拒绝" });
				return false;
			}
			// 带上 stateDigest 做可见回报(如 console.clear 的 {cleared:N}),避免「点了没反应」。
			const digest =
				res.stateDigest !== undefined
					? ` · ${JSON.stringify(res.stateDigest)}`
					: "";
			setFeedback({
				kind: "ok",
				text:
					(res.status === "accepted" ? "已受理(异步执行中)" : "已执行") +
					digest,
			});
			return true;
		},
		[],
	);

	/** 列表里选中一条:有参数 → 进引导;无参数 → 直接执行。 */
	const onSelect = useCallback(
		(id: string) => {
			const def = getAction(id);
			const params = def ? paramsOf(def) : [];
			if (def && params.length > 0) {
				const init: Record<string, string> = {};
				for (const p of params) {
					init[p.key] = p.enum?.length
						? String(p.enum[0])
						: p.type === "boolean"
							? "true"
							: "";
				}
				setFeedback(null);
				setValues(init);
				setFormDef(def);
				return;
			}
			void execute(id, {}).then((ok) => {
				if (ok) scheduleClose();
			});
		},
		[execute, scheduleClose],
	);

	const submit = useCallback(async () => {
		if (!formDef) return;
		const args: Record<string, unknown> = {};
		for (const p of paramsOf(formDef)) {
			const raw = values[p.key] ?? "";
			if (raw === "") {
				if (p.required) {
					setFeedback({ kind: "err", text: `「${p.key}」为必填` });
					return;
				}
				continue; // 可选留空 → 不发该键
			}
			const c = coerce(raw, p.type);
			if (!c.ok) {
				setFeedback({ kind: "err", text: `「${p.key}」${c.err}` });
				return;
			}
			args[p.key] = c.value;
		}
		const ok = await execute(formDef.id, args);
		if (ok) scheduleClose();
	}, [formDef, values, execute, scheduleClose]);

	const enabled = useMemo(() => rows.filter((r) => r.available), [rows]);
	const disabled = useMemo(() => rows.filter((r) => !r.available), [rows]);

	if (!open) return null;

	// ── 参数引导子界面 ────────────────────────────────────────────────────────
	if (formDef) {
		const params = paramsOf(formDef);
		return (
			<div
				className="fx-cmdk-overlay"
				role="dialog"
				aria-modal="true"
				onClick={(event) => {
					if (event.target === event.currentTarget) close();
				}}
				onKeyDown={(e) => {
					if (e.nativeEvent.isComposing) return;
					if (e.key === "Escape") {
						e.preventDefault();
						if (formDef) {
							setFormDef(null);
							setValues({});
							setFeedback(null);
						} else close();
					}
				}}
				tabIndex={-1}
			>
				<div className="fx-cmdk-panel">
					<div className="fx-cmdk-form-head">
						<button
							className="fx-cmdk-back"
							type="button"
							onClick={() => setFormDef(null)}
							title="返回命令列表"
						>
							← 返回
						</button>
						<span className="fx-cmdk-title">{formDef.title}</span>
						<span className="fx-cmdk-id">{formDef.id}</span>
					</div>
					{formDef.description && (
						<p className="fx-cmdk-guide">{formDef.description}</p>
					)}
					<form
						className="fx-cmdk-form"
						onSubmit={(e) => {
							e.preventDefault();
							void submit();
						}}
					>
						{params.map((p, i) => {
							const setRef = (el: HTMLElement | null) => {
								if (i === 0) firstFieldRef.current = el;
							};
							const val = values[p.key] ?? "";
							const onChange = (v: string) =>
								setValues((s) => ({ ...s, [p.key]: v }));
							const isDyn = !!formDef.choices?.[p.key]; // 该字段有动态候选提供器
							const dynList = choices[p.key]; // undefined=解析中,[]=无项,[...]=候选
							return (
								<label
									className="fx-cmdk-field"
									htmlFor={`fx-cmdk-${p.key}`}
									key={p.key}
								>
									<span className="fx-cmdk-field-label">
										{p.key}
										{p.required && <em className="fx-cmdk-req">*</em>}
										<small className="fx-cmdk-field-hint">{typeHint(p)}</small>
									</span>
									{p.enum?.length ? (
										<select
											ref={setRef as (el: HTMLSelectElement | null) => void}
											value={val}
											onChange={(e) => onChange(e.target.value)}
										>
											{p.enum.map((o) => (
												<option key={String(o)} value={String(o)}>
													{String(o)}
												</option>
											))}
										</select>
									) : isDyn ? (
										dynList === undefined ? (
											<select
												id={`fx-cmdk-${p.key}`}
												disabled
												ref={setRef as (el: HTMLSelectElement | null) => void}
											>
												<option>加载中…</option>
											</select>
										) : dynList.length === 0 ? (
											<select
												id={`fx-cmdk-${p.key}`}
												disabled
												ref={setRef as (el: HTMLSelectElement | null) => void}
											>
												<option>无可用项</option>
											</select>
										) : (
											<select
												id={`fx-cmdk-${p.key}`}
												ref={setRef as (el: HTMLSelectElement | null) => void}
												value={val}
												onChange={(e) => onChange(e.target.value)}
											>
												{dynList.map((o) => (
													<option key={o} value={o}>
														{o}
													</option>
												))}
											</select>
										)
									) : p.type === "boolean" ? (
										<select
											id={`fx-cmdk-${p.key}`}
											ref={setRef as (el: HTMLSelectElement | null) => void}
											value={val}
											onChange={(e) => onChange(e.target.value)}
										>
											<option value="true">true</option>
											<option value="false">false</option>
										</select>
									) : p.type === "number" || p.type === "integer" ? (
										<input
											id={`fx-cmdk-${p.key}`}
											ref={setRef as (el: HTMLInputElement | null) => void}
											type="number"
											value={val}
											onChange={(e) => onChange(e.target.value)}
											placeholder={p.type}
										/>
									) : (
										<textarea
											id={`fx-cmdk-${p.key}`}
											ref={setRef as (el: HTMLTextAreaElement | null) => void}
											rows={p.type === "object" || p.type === "array" ? 3 : 2}
											value={val}
											onChange={(e) => onChange(e.target.value)}
											placeholder={
												p.type === "object" || p.type === "array"
													? "JSON…"
													: `输入 ${p.key}…`
											}
											onKeyDown={(e) => {
												if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
													e.preventDefault();
													void submit();
												}
											}}
										/>
									)}
									{p.description && (
										<small className="fx-cmdk-field-desc">
											{p.description}
										</small>
									)}
								</label>
							);
						})}
						{feedback && (
							<div
								className={`fx-cmdk-feedback fx-cmdk-feedback--${feedback.kind}`}
							>
								{feedback.text}
							</div>
						)}
						<div className="fx-cmdk-form-actions">
							<span className="fx-cmdk-form-tip">Enter 执行 · Esc 返回</span>
							<button type="submit" className="fx-cmdk-run">
								执行
							</button>
						</div>
					</form>
				</div>
			</div>
		);
	}

	// ── 命令列表 ──────────────────────────────────────────────────────────────
	return (
		<div
			className="fx-cmdk-overlay"
			role="dialog"
			aria-modal="true"
			onClick={(event) => {
				if (event.target === event.currentTarget) close();
			}}
			onKeyDown={(e) => {
				if (!e.nativeEvent.isComposing && e.key === "Escape") {
					e.preventDefault();
					close();
				}
			}}
			tabIndex={-1}
		>
			<div className="fx-cmdk-panel">
				<Command label="命令面板">
					<Command.Input
						autoFocus
						placeholder="输入命令…(与 AI 可调用的功能同一张注册表)"
					/>
					<Command.List>
						<Command.Empty>没有匹配的命令</Command.Empty>
						{enabled.map((r) => (
							<Command.Item
								key={r.id}
								value={`${r.title} ${r.id}`}
								onSelect={() => onSelect(r.id)}
							>
								<span className="fx-cmdk-title">{r.title}</span>
								<span className="fx-cmdk-id">{r.id}</span>
							</Command.Item>
						))}
						{disabled.length > 0 && (
							<Command.Group heading="当前不可用">
								{disabled.map((r) => (
									<Command.Item
										key={r.id}
										value={`${r.title} ${r.id}`}
										disabled
									>
										<span className="fx-cmdk-title">{r.title}</span>
										<span className="fx-cmdk-reason">{r.reason}</span>
									</Command.Item>
								))}
							</Command.Group>
						)}
					</Command.List>
				</Command>
				{feedback && (
					<div
						className={`fx-cmdk-feedback fx-cmdk-feedback--${feedback.kind}`}
					>
						{feedback.text}
					</div>
				)}
			</div>
		</div>
	);
}
