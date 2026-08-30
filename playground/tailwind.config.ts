import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        ground: "#080c10",
        surface: "#0f1620",
        "surface-2": "#16202e",
        "surface-3": "#1f2d3f",
        accent: {
          DEFAULT: "#38bdf8",
          hover: "#7dd3fc",
          soft: "rgba(56, 189, 248, 0.12)",
          glow: "rgba(56, 189, 248, 0.28)",
          secondary: "#818cf8",
        },
        ok: {
          DEFAULT: "#34d399",
          bg: "rgba(52, 211, 153, 0.12)",
        },
        fail: {
          DEFAULT: "#f87171",
          bg: "rgba(248, 113, 113, 0.12)",
        },
        warn: {
          DEFAULT: "#fbbf24",
          bg: "rgba(251, 191, 36, 0.12)",
        },
      },
      fontFamily: {
        sans: ["var(--font-sans)", "Plus Jakarta Sans", "Inter", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "JetBrains Mono", "ui-monospace", "monospace"],
      },
      animation: {
        "pulse-beacon": "pulse-beacon 2s infinite ease-in-out",
        shimmer: "shimmer 2.5s infinite linear",
      },
      keyframes: {
        "pulse-beacon": {
          "0%, 100%": { transform: "scale(1)", opacity: "1" },
          "50%": { transform: "scale(1.3)", opacity: "0.6" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
      },
    },
  },
  plugins: [],
};

export default config;
