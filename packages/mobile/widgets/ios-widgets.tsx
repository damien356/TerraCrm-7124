import type { Widget } from "expo-widgets";
import type { MyJobProps, TodayProps } from "../lib/widget-model";

/**
 * Everywhere but the iPhone (Damien, 14 Nov 2026).
 *
 * The real iPhone widgets live in ios-widgets.ios.tsx, which the iPhone build
 * picks up instead of this file. Android draws its own widgets
 * (android-widgets.tsx), and the web has none, so here there is nothing to
 * update.
 */
export const terraTodayWidget: Widget<TodayProps> | null = null;
export const myJobWidget: Widget<MyJobProps> | null = null;
