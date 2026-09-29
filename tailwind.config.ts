import animate from "tailwindcss-animate";
import { createForgeaxPreset } from "./src/styles/tailwind-preset";

const config = {
	presets: [createForgeaxPreset()],
	content: {
		relative: true,
		files: [
			"./index.html",
			"./src/**/*.{ts,tsx}",
			// Compatibility views still render from Interface until their IDE cuts land.
			"../interface/src/**/*.{ts,tsx}",
			"../editor/packages/*/src/**/*.{ts,tsx}",
		],
	},
	corePlugins: { preflight: false },
	plugins: [animate],
};

export default config;
