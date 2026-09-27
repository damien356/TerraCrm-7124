import { Platform } from "react-native";

/**
 * Terra Ops field app tokens — same vocabulary as the web app
 * (`packages/web/src/web/styles.css`) so the two platforms match.
 * Terracotta primary, charcoal shell, warm off-white paper.
 */
export const Colors = {
  light: {
    background: "#FAF9F7",
    foreground: "#1C1B1A",
    card: "#FFFFFF",
    cardForeground: "#1C1B1A",
    primary: "#C05A2B",
    primaryForeground: "#FFFFFF",
    secondary: "#F1EEEA",
    secondaryForeground: "#1C1B1A",
    muted: "#F1EEEA",
    mutedForeground: "#7A736D",
    accent: "#EFE7E1",
    accentForeground: "#1C1B1A",
    border: "#E7E4E0",
    destructive: "#C0392B",
    success: "#3F7D3A",
    warning: "#D08A1E",
    sidebar: "#1C1B1A",
  },
  dark: {
    background: "#141312",
    foreground: "#F7F5F2",
    card: "#1F1E1C",
    cardForeground: "#F7F5F2",
    primary: "#D9713F",
    primaryForeground: "#FFFFFF",
    secondary: "#2A2826",
    secondaryForeground: "#F7F5F2",
    muted: "#2A2826",
    mutedForeground: "#A39C95",
    accent: "#332F2C",
    accentForeground: "#F7F5F2",
    border: "#312E2B",
    destructive: "#E05B4A",
    success: "#5DA556",
    warning: "#E0A33C",
    sidebar: "#0F0E0D",
  },
} as const;

export type ColorScheme = keyof typeof Colors;
export type ThemeColors = (typeof Colors)[ColorScheme];

/** Skill group → task card tint, mirroring the web board. */
export const SkillTint: Record<string, { fill: string; edge: string }> = {
  carpet: { fill: "#DCE8F2", edge: "#4A7FA5" },
  resilient: { fill: "#E2EFDF", edge: "#5C8A52" },
  timber: { fill: "#F5E8D8", edge: "#B07B3A" },
  prep: { fill: "#EDE9E4", edge: "#7A736D" },
  demolition: { fill: "#F7E2DE", edge: "#C0603F" },
  trades: { fill: "#EDE4F2", edge: "#7A6A9E" },
  other: { fill: "#EFECE8", edge: "#7A736D" },
};

export function tintFor(group?: string | null) {
  return SkillTint[group ?? "other"] ?? SkillTint.other;
}

export const Fonts = Platform.select({
  ios: {
    sans: "Poppins_400Regular",
    medium: "Poppins_500Medium",
    bold: "Poppins_600SemiBold",
    mono: "ui-monospace",
  },
  default: {
    sans: "Poppins_400Regular",
    medium: "Poppins_500Medium",
    bold: "Poppins_600SemiBold",
    mono: "monospace",
  },
  web: {
    sans: "Poppins_400Regular, system-ui, sans-serif",
    medium: "Poppins_500Medium, system-ui, sans-serif",
    bold: "Poppins_600SemiBold, system-ui, sans-serif",
    mono: "'SF Mono', 'Roboto Mono', monospace",
  },
})!;
