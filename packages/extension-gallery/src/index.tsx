import type { AppExtension, AppHost } from "@forgeax/app-shell/application";
import { useEffect, useState } from "react";
import {
	extensionGalleryIcon,
	extensionGalleryText,
	openExtensionGalleryPage,
} from "./runtime";

export interface ExtensionGalleryInfo {
	readonly id: string;
	readonly version?: string;
	readonly displayName?: string | Record<string, string>;
	readonly description?: string | Record<string, string>;
	readonly icon?: string;
	readonly experimental?: boolean;
	readonly tools?: readonly unknown[];
	readonly events?: readonly unknown[];
	readonly contributes?: {
		readonly pages?: readonly {
			readonly id?: string;
			readonly icon?: string;
		}[];
		readonly activities?: readonly { readonly icon?: string }[];
	};
}

export interface ExtensionGalleryRuntime {
	useTranslation(): {
		readonly t: (key: string) => string;
		readonly locale: string;
	};
	listExtensions(): Promise<{
		readonly items: readonly ExtensionGalleryInfo[];
	}>;
}

function placeholderText(t: (key: string) => string): string {
	return t("extension.editorPlaceholder");
}

function GalleryContent({
	runtime,
	openExtensionPage,
}: {
	readonly runtime: ExtensionGalleryRuntime;
	readonly openExtensionPage: (extensionId: string) => void | Promise<void>;
}) {
	const { t, locale } = runtime.useTranslation();
	const [extensions, setExtensions] = useState<
		readonly ExtensionGalleryInfo[] | null
	>(null);
	const [errored, setErrored] = useState(false);

	useEffect(() => {
		let cancelled = false;
		runtime
			.listExtensions()
			.then((result) => {
				if (cancelled) return;
				const visible = result.items.filter(
					(item) => (item.contributes?.pages?.length ?? 0) > 0,
				);
				visible.sort((left, right) => left.id.localeCompare(right.id));
				setExtensions(visible);
			})
			.catch(() => {
				if (!cancelled) setErrored(true);
			});
		return () => {
			cancelled = true;
		};
	}, [runtime]);

	if (errored || (extensions && extensions.length === 0)) {
		return (
			<pre className="cm-mock thin-scrollbar">
				<code>{placeholderText(t)}</code>
			</pre>
		);
	}
	if (extensions === null) {
		return (
			<div className="page-gallery thin-scrollbar" aria-busy="true">
				<div className="page-gallery-header">
					<span className="page-gallery-title">
						{t("extension.galleryTitle")}
					</span>
					<span className="page-gallery-sub">
						{t("extension.loadingExtensionList")}
					</span>
				</div>
			</div>
		);
	}

	const wipCount = extensions.filter(
		(extension) => extension.experimental === true,
	).length;
	const totalTools = extensions.reduce(
		(total, extension) => total + (extension.tools?.length ?? 0),
		0,
	);
	const totalEvents = extensions.reduce(
		(total, extension) => total + (extension.events?.length ?? 0),
		0,
	);
	const bumpedCount = extensions.filter(
		(extension) => !/^0\.0\./.test(extension.version ?? "0.0.0"),
	).length;
	const statsTitle = `Σ ${extensions.length} page plugin · ${wipCount} experimental(WIP) · ${totalTools} tool(s) on bus · ${totalEvents} event(s) emitted · ${bumpedCount} ${t("extension.bumpedStatsSuffix")}`;
	const statsAria = `${extensions.length} page extensions total — ${wipCount} experimental, ${totalTools} tools, ${totalEvents} events, ${bumpedCount} bumped`;

	return (
		<div className="page-gallery thin-scrollbar">
			<div className="page-gallery-header">
				<span className="page-gallery-title">
					{t("extension.galleryTitle")}
				</span>
				<span className="page-gallery-count">
					· {extensions.length} extensions
				</span>
				<fieldset
					className="page-gallery-stats"
					title={statsTitle}
					aria-label={statsAria}
				>
					<span className="page-gallery-stats-pill page-gallery-stats-total">
						<span className="page-gallery-stats-sigma" aria-hidden>
							Σ
						</span>
						<span className="page-gallery-stats-n">{extensions.length}</span>
					</span>
					<span className="page-gallery-stats-vsep" aria-hidden />
					{wipCount > 0 && (
						<span className="page-gallery-stats-pill page-gallery-stats-wip">
							WIP <span className="page-gallery-stats-n">{wipCount}</span>
						</span>
					)}
					{totalTools > 0 && (
						<span className="page-gallery-stats-pill page-gallery-stats-tools">
							🛠 <span className="page-gallery-stats-n">{totalTools}</span>
						</span>
					)}
					{totalEvents > 0 && (
						<span className="page-gallery-stats-pill page-gallery-stats-events">
							📡 <span className="page-gallery-stats-n">{totalEvents}</span>
						</span>
					)}
					{bumpedCount > 0 && (
						<span
							className="page-gallery-stats-pill page-gallery-stats-bumped"
							role="img"
							aria-label={`${bumpedCount} bumped`}
						>
							<span aria-hidden>v</span>
							<span className="page-gallery-stats-n">{bumpedCount}</span>
						</span>
					)}
				</fieldset>
				<span className="page-gallery-sub">{t("extension.gallerySub")}</span>
			</div>
			<div className="page-gallery-grid">
				{extensions.map((extension, index) => {
					const rank = index + 1;
					const pageId = extension.contributes?.pages?.[0]?.id ?? extension.id;
					const name = extensionGalleryText(
						extension.displayName,
						locale,
						pageId,
					);
					const description = extensionGalleryText(
						extension.description,
						locale,
						"",
					);
					const Icon = extensionGalleryIcon(
						extension.contributes?.activities?.[0]?.icon ??
							extension.contributes?.pages?.[0]?.icon ??
							extension.icon,
					);
					const toolCount = extension.tools?.length ?? 0;
					const eventCount = extension.events?.length ?? 0;
					const isWip = extension.experimental === true;
					const version = extension.version ?? "0.0.0";
					const versionBumped = !/^0\.0\./.test(version);
					const titleParts = [
						`#${rank} · ${name}`,
						extension.id,
						`v${version}`,
					];
					if (isWip) titleParts.push("experimental placeholder");
					if (toolCount > 0)
						titleParts.push(`${toolCount} tool${toolCount === 1 ? "" : "s"}`);
					if (eventCount > 0)
						titleParts.push(
							`${eventCount} event${eventCount === 1 ? "" : "s"}`,
						);
					return (
						<button
							key={extension.id}
							type="button"
							className={`page-gallery-tile size-md${versionBumped ? " bumped" : ""}`}
							onClick={() => {
								void openExtensionPage(extension.id);
							}}
							title={titleParts.join(" · ")}
							aria-label={`#${rank} ${name}${versionBumped ? " · bumped" : ""}`}
						>
							<span
								className="page-gallery-tile-rank"
								title={`#${rank} of ${extensions.length} · ${t("extension.positionDecidesOrder")}`}
								aria-hidden
							>
								#{rank}
							</span>
							<span className="page-gallery-tile-ico" aria-hidden>
								<Icon size={22} strokeWidth={1.8} />
								{versionBumped && (
									<sup className="page-gallery-tile-ico-ver" aria-hidden>
										v
									</sup>
								)}
							</span>
							<span className="page-gallery-tile-name">{name}</span>
							{description && (
								<span className="page-gallery-tile-desc">{description}</span>
							)}
							<span className="page-gallery-tile-meta">
								<span className="page-gallery-tile-tag">page-{pageId}</span>
								<span className="page-gallery-tile-tag size">md</span>
								<span
									className={`page-gallery-tile-tag ver${versionBumped ? " bumped" : ""}`}
									role="img"
									aria-label={`version ${version}`}
								>
									v{version}
								</span>
								{isWip && (
									<span className="page-gallery-tile-tag wip">WIP</span>
								)}
								{toolCount > 0 && (
									<span className="page-gallery-tile-tag tools">
										🛠 {toolCount}
									</span>
								)}
								{eventCount > 0 && (
									<span className="page-gallery-tile-tag events">
										📡 {eventCount}
									</span>
								)}
							</span>
						</button>
					);
				})}
			</div>
		</div>
	);
}

export function ExtensionGallery({
	runtime,
	openExtensionPage,
}: {
	readonly runtime: ExtensionGalleryRuntime;
	readonly openExtensionPage: (extensionId: string) => void | Promise<void>;
}) {
	return (
		<div className="page-mode">
			<div className="page-editor">
				<GalleryContent
					runtime={runtime}
					openExtensionPage={openExtensionPage}
				/>
			</div>
		</div>
	);
}

export function createExtensionGalleryContribution(
	runtime: ExtensionGalleryRuntime,
): AppExtension {
	let host: AppHost | null = null;

	function ExtensionGallerySlot() {
		return (
			<ExtensionGallery
				runtime={runtime}
				openExtensionPage={(extensionId) => {
					if (!host) throw new Error("Page host is not ready");
					return openExtensionGalleryPage(host, extensionId);
				}}
			/>
		);
	}

	return {
		id: "@forgeax/extension-gallery",
		version: "0.1.0",
		contributes: { panels: { slots: { MainAreaBody: ExtensionGallerySlot } } },
		setup(context) {
			host = context.host;
			return () => {
				if (host === context.host) host = null;
			};
		},
	};
}
