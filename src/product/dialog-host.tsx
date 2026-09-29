import { applicationDialogs } from "@forgeax/app-shell/application";
import { useApplicationDialogRequest } from "@forgeax/app-shell/react";
import * as Dialog from "@radix-ui/react-alert-dialog";
import { useTranslation } from "./product-locale";
import "./dialog-host.css";

/** Product copy and presentation for the single App Shell dialog queue. */
export function IdeDialogHost() {
	const { t } = useTranslation();
	const request = useApplicationDialogRequest();
	if (!request) return null;

	const isConfirm = request.kind === "confirm";
	const isUnsaved = request.kind === "unsaved";
	const cancel = () => {
		if (isUnsaved) applicationDialogs.resolveUnsaved(request.id, "cancel");
		else applicationDialogs.resolveConfirmAlert(request.id, false);
	};

	return (
		<Dialog.Root open onOpenChange={(open) => !open && cancel()}>
			<Dialog.Portal>
				<Dialog.Overlay className="ide-dialog-overlay" />
				<Dialog.Content className="ide-dialog-content">
					<Dialog.Title
						className={
							request.options.title
								? "ide-dialog-title"
								: "ide-dialog-visually-hidden"
						}
					>
						{request.options.title ??
							(isUnsaved
								? t("dialog.unsavedTitle")
								: isConfirm
									? t("dialog.confirmActionTitle")
									: t("dialog.alertTitle"))}
					</Dialog.Title>
					{request.options.body && (
						<Dialog.Description asChild>
							<div className="ide-dialog-description">
								{request.options.body}
							</div>
						</Dialog.Description>
					)}
					<div className="ide-dialog-actions">
						{(isConfirm || isUnsaved) && (
							<Dialog.Cancel
								className="ide-dialog-button ide-dialog-button--cancel"
								onClick={cancel}
							>
								{request.options.cancelText ?? t("common.cancel")}
							</Dialog.Cancel>
						)}
						{isUnsaved && (
							<Dialog.Action
								className="ide-dialog-button ide-dialog-button--danger"
								onClick={() =>
									applicationDialogs.resolveUnsaved(request.id, "discard")
								}
							>
								{request.options.discardText ?? t("dialog.discardChanges")}
							</Dialog.Action>
						)}
						<Dialog.Action
							autoFocus
							className={`ide-dialog-button${isConfirm && request.options.danger ? " ide-dialog-button--danger" : " ide-dialog-button--primary"}`}
							onClick={() => {
								if (isUnsaved)
									applicationDialogs.resolveUnsaved(request.id, "save");
								else applicationDialogs.resolveConfirmAlert(request.id, true);
							}}
						>
							{isUnsaved
								? (request.options.saveText ?? t("common.save"))
								: isConfirm
									? (request.options.confirmText ?? t("common.confirm"))
									: (request.options.okText ?? t("common.ok"))}
						</Dialog.Action>
					</div>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
