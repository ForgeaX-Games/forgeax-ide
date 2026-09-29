/**
 * Business-agnostic status-bar popover shell.
 *
 * The shell owns only the trigger, Radix portal/content, focus handling, and
 * the header slots. Callers provide the label, title, and body; no product or
 * Host dependency belongs here.
 */
import * as Popover from "@radix-ui/react-popover";
import { icons as LucideIcons } from "lucide-react";
import type { ReactNode } from "react";
import "./strip-popover.css";

export interface StripPopoverProps {
	/** lucide icon name for the chip button. */
	readonly icon?: string;
	/** chip button label (text or node, e.g. version + draft badge). */
	readonly label?: ReactNode;
	/** popover header content (icon + title). */
	readonly title: ReactNode;
	/** native title/tooltip on the chip button. */
	readonly tooltip?: string;
	/** right-aligned header slot (e.g. a primary action button). */
	readonly headerAction?: ReactNode;
	readonly children: ReactNode;
}

export function StripPopover({
	icon,
	label,
	title,
	tooltip,
	headerAction,
	children,
}: StripPopoverProps) {
	const Icon = icon ? LucideIcons[icon as keyof typeof LucideIcons] : undefined;

	return (
		<Popover.Root>
			<Popover.Trigger asChild>
				<button
					type="button"
					className="sb-chip is-button fx-strip-pop-btn"
					title={tooltip}
					aria-label={typeof label === "string" ? label : tooltip}
				>
					{Icon ? <Icon size={12} className="sb-chip-icon" /> : null}
					{label != null ? (
						<span className="sb-chip-label">{label}</span>
					) : null}
				</button>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					className="fx-strip-pop"
					side="top"
					align="center"
					sideOffset={6}
					collisionPadding={8}
					onOpenAutoFocus={(event) => event.preventDefault()}
				>
					<div className="fx-strip-pop-h">
						{title}
						{headerAction ? (
							<span className="fx-strip-pop-h-act">{headerAction}</span>
						) : null}
					</div>
					{children}
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}
