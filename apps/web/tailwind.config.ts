import type { Config } from "tailwindcss";

/** Doott brand: white surfaces, red accent, warm neutral greys. Light theme only. */
export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  darkMode: "class", // never toggled → the app stays white-and-red regardless of OS theme
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        display: ["var(--font-display)", "var(--font-sans)", "ui-sans-serif", "sans-serif"],
      },
      colors: {
        brand: {
          50: "#fff1f2",
          100: "#ffe1e3",
          200: "#ffc7cc",
          300: "#ff9aa3",
          400: "#fb5f6d",
          500: "#ef3346",
          600: "#d9142b", // primary
          700: "#b70d22",
          800: "#970f21",
          900: "#7e1222",
          950: "#46040d",
        },
        ink: { 50: "#f8f8f9", 100: "#f1f1f3", 200: "#e4e4e8", 300: "#cfcfd6", 400: "#9d9daa", 500: "#6e6e7d", 600: "#55555f", 700: "#3f3f48", 800: "#27272e", 900: "#16161b" },
        wa: { 50: "#ecfdf3", 500: "#22a861", 600: "#16884c" },
      },
      boxShadow: {
        card: "0 1px 2px rgba(22,22,27,.04), 0 1px 1px rgba(22,22,27,.03)",
        lift: "0 8px 24px -8px rgba(22,22,27,.14), 0 2px 6px rgba(22,22,27,.05)",
        glow: "0 6px 20px -6px rgba(217,20,43,.45)",
      },
      borderRadius: { xl: "0.875rem", "2xl": "1.125rem" },
      keyframes: {
        "fade-in": { from: { opacity: "0", transform: "translateY(4px)" }, to: { opacity: "1", transform: "none" } },
      },
      animation: { "fade-in": "fade-in .18s ease-out" },
    },
  },
  plugins: [],
} satisfies Config;
