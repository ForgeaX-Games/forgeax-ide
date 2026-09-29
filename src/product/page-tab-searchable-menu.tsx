import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	CommandSeparator,
} from "@forgeax/editor/ui/command";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@forgeax/editor/ui/popover";
import {
	type ComponentType,
	type ReactElement,
	type ReactNode,
	useMemo,
	useState,
} from "react";

import "./page-tab-searchable-menu.css";

export interface SearchableMenuItem {
	id: string;
	label: string;
	description?: string;
	keywords?: readonly string[];
	group?: string;
	icon?: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
	disabled?: boolean;
}

interface SearchableMenuProps {
	trigger: ReactElement;
	items: readonly SearchableMenuItem[];
	onSelect: (item: SearchableMenuItem) => void;
	searchPlaceholder: string;
	emptyText: string;
	ariaLabel: string;
	className?: string;
	footer?: ReactNode;
}

/**
 * Shared UE-style searchable anchored menu. Popover owns focus/escape/collision;
 * cmdk owns filtering and keyboard selection. Domain callers only provide data.
 */
export function SearchableMenu({
	trigger,
	items,
	onSelect,
	searchPlaceholder,
	emptyText,
	ariaLabel,
	className,
	footer,
}: SearchableMenuProps): ReactElement {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const groups = useMemo(() => {
		const grouped = new Map<string, SearchableMenuItem[]>();
		for (const item of items) {
			const key = item.group ?? "";
			const group = grouped.get(key);
			if (group) group.push(item);
			else grouped.set(key, [item]);
		}
		return [...grouped.entries()];
	}, [items]);

	const changeOpen = (next: boolean): void => {
		setOpen(next);
		if (!next) setQuery("");
	};

	return (
		<Popover open={open} onOpenChange={changeOpen}>
			<PopoverTrigger asChild>{trigger}</PopoverTrigger>
			<PopoverContent
				align="start"
				sideOffset={4}
				className={["fx-searchable-menu", className].filter(Boolean).join(" ")}
			>
				<Command className="fx-searchable-menu__command" label={ariaLabel}>
					<CommandInput
						autoFocus
						className="fx-searchable-menu__input"
						value={query}
						onValueChange={setQuery}
						placeholder={searchPlaceholder}
					/>
					<CommandList className="fx-searchable-menu__list">
						<CommandEmpty className="fx-searchable-menu__empty">
							{emptyText}
						</CommandEmpty>
						{groups.map(([group, groupItems], groupIndex) => (
							<div key={group || "__default"}>
								{groupIndex > 0 && (
									<CommandSeparator className="fx-searchable-menu__separator" />
								)}
								<CommandGroup
									className="fx-searchable-menu__group"
									heading={group || undefined}
								>
									{groupItems.map((item) => {
										const Icon = item.icon;
										const value = [
											item.label,
											item.id,
											...(item.keywords ?? []),
										].join(" ");
										return (
											<CommandItem
												key={item.id}
												className="fx-searchable-menu__item"
												value={value}
												disabled={item.disabled}
												onSelect={() => {
													onSelect(item);
													changeOpen(false);
												}}
											>
												{Icon && (
													<Icon
														className="fx-searchable-menu__icon"
														aria-hidden
													/>
												)}
												<span className="fx-searchable-menu__content">
													<span className="fx-searchable-menu__label">
														{item.label}
													</span>
													{item.description && (
														<span className="fx-searchable-menu__description">
															{item.description}
														</span>
													)}
												</span>
											</CommandItem>
										);
									})}
								</CommandGroup>
							</div>
						))}
					</CommandList>
					{footer && <div className="fx-searchable-menu__footer">{footer}</div>}
				</Command>
			</PopoverContent>
		</Popover>
	);
}
