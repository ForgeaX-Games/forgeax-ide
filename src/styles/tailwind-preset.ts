/**
 * IDE Tailwind preset: maps local --fx-* and --radius-* tokens to semantic
 * utility colors and radii. Keep this mapping aligned with fx-bridge.css.
 * Fallbacks preserve the dark skin before tokens.css has loaded.
 *
 * The preset itself is dependency-free; the IDE Tailwind config adds plugins.
 */

type ColorToken = string | { DEFAULT?: string; foreground?: string };

export interface ForgeaxPreset {
	darkMode: ["selector", string];
	theme: {
		extend: {
			colors: Record<string, ColorToken>;
			borderRadius: Record<string, string>;
		};
	};
}

export function createForgeaxPreset(): ForgeaxPreset {
	return {
		// `tokens.css` keys the dark skin off `:root` today; this selector keeps
		// Tailwind's `dark:` variant aligned for when light skins land.
		darkMode: ["selector", '[data-theme="dark"]'],
		theme: {
			extend: {
				colors: {
					border: "var(--fx-border, #404040)",
					input: "var(--fx-border, #404040)",
					ring: "var(--fx-accent, #D4FF48)",
					background: "var(--fx-bg, #0D0D0D)",
					foreground: "var(--fx-fg, #FFFFFF)",
					muted: {
						DEFAULT: "var(--fx-bg-elev2, #191919)",
						foreground: "var(--fx-fg-muted, rgba(255,255,255,0.6))",
					},
					card: {
						DEFAULT: "var(--fx-bg-elev1, #242424)",
						foreground: "var(--fx-fg, #FFFFFF)",
					},
					popover: {
						DEFAULT: "var(--fx-bg-elev1, #242424)",
						foreground: "var(--fx-fg, #FFFFFF)",
					},
					accent: {
						DEFAULT: "var(--fx-accent, #D4FF48)",
						foreground: "var(--fx-bg, #0D0D0D)",
					},
					primary: {
						DEFAULT: "var(--fx-accent, #D4FF48)",
						foreground: "var(--fx-bg, #0D0D0D)",
					},
					secondary: {
						DEFAULT: "var(--fx-bg-elev2, #191919)",
						foreground: "var(--fx-fg, #FFFFFF)",
					},
					destructive: {
						DEFAULT: "var(--fx-danger, #BE3636)",
						foreground: "var(--fx-fg, #FFFFFF)",
					},
					success: { DEFAULT: "var(--fx-success, #1B9D4B)" },
					danger: { DEFAULT: "var(--fx-danger, #BE3636)" },
					info: { DEFAULT: "var(--fx-info, #639CF8)" },
				},
				borderRadius: {
					lg: "var(--radius-lg, 12px)",
					md: "var(--radius-md, 8px)",
					sm: "var(--radius-sm, 4px)",
				},
			},
		},
	};
}

export const forgeaxPreset = createForgeaxPreset();
