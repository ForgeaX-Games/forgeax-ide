/** Product prompt for Chat readiness interception; Chat retains the pending message. */
import { installCustomEventObservation } from "@forgeax/app-shell/react";
import { APP_EVENTS } from "@forgeax/chat/runtime";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "./product-locale";
import { useShellStore } from "./shell-state-runtime";
import "./connect-model-prompt.css";

export function IdeConnectModelPrompt() {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const openOverlay = useShellStore((s) => s.openOverlay);

	useEffect(() => {
		const onOpen = () => setOpen(true);
		const disposeOpenPromptObservation = installCustomEventObservation({
			target: window,
			eventType: APP_EVENTS.openConnectPrompt,
			onEvent: onOpen,
		});
		return disposeOpenPromptObservation;
	}, []);

	const gotoProviders = useCallback(() => {
		setOpen(false);
		openOverlay("settings", "providers");
	}, [openOverlay]);

	if (!open) return null;

	return (
		<div
			className="fx-ob-modal-scrim"
			style={{ zIndex: 99998 }}
			role="dialog"
			aria-modal="true"
			aria-labelledby="fx-connect-model-prompt-title"
			onClick={(event) => {
				if (event.target === event.currentTarget) setOpen(false);
			}}
			onKeyDown={(event) => {
				if (event.key === "Escape") setOpen(false);
			}}
			tabIndex={-1}
		>
			<div className="fx-ob-modal">
				<div className="fx-ob-modal-inner">
					<div className="fx-ob-stack fx-ob-gap6">
						<h2 id="fx-connect-model-prompt-title" className="fx-ob-h2">
							{t("onboarding.nudge.connectTitle")}
						</h2>
						<div className="fx-ob-sec">{t("onboarding.nudge.connectSub")}</div>
					</div>
					<div className="fx-ob-stack fx-ob-gap8">
						<button
							type="button"
							className="fx-ob-btn fx-ob-btn-primary fx-ob-btn-block"
							onClick={gotoProviders}
						>
							{t("onboarding.nudge.connectKey")}
						</button>
						<button
							type="button"
							className="fx-ob-btn fx-ob-btn-secondary fx-ob-btn-block"
							onClick={gotoProviders}
						>
							{t("onboarding.nudge.connectCli")}
						</button>
					</div>
					<div className="fx-ob-row" style={{ justifyContent: "center" }}>
						<button
							type="button"
							className="fx-ob-btn fx-ob-btn-ghost"
							onClick={() => setOpen(false)}
						>
							{t("onboarding.nudge.connectCancel")}
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}
