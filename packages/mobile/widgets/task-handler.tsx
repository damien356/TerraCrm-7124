import type { WidgetTaskHandlerProps } from "react-native-android-widget";
import { myJobView, todayView } from "../lib/widget-model";
import { readCache } from "../lib/widget-store";
import { ANDROID_WIDGETS, MyJobAndroid, TerraTodayAndroid } from "./android-widgets";

/**
 * ANDROID REDRAWS THE WIDGET (Damien, 14 Nov 2026).
 *
 * Android calls this when a widget is added, resized, or every 30 minutes,
 * even with Terra shut. It only redraws from the copy saved at Terra's last
 * sync, so the next booking still rolls forward and an old copy still turns
 * into "Open Terra to refresh". It never asks the server. Taps open links
 * straight away, so there is nothing to do for a click.
 */
export async function widgetTaskHandler(props: WidgetTaskHandlerProps) {
  const { widgetInfo, widgetAction, renderWidget } = props;
  if (widgetAction !== "WIDGET_ADDED" && widgetAction !== "WIDGET_UPDATE" && widgetAction !== "WIDGET_RESIZED") return;
  const cache = await readCache().catch(() => null);
  const now = Date.now();
  if (widgetInfo.widgetName === ANDROID_WIDGETS.today) renderWidget(TerraTodayAndroid(todayView(cache, now), widgetInfo));
  else if (widgetInfo.widgetName === ANDROID_WIDGETS.job) renderWidget(MyJobAndroid(myJobView(cache, now), widgetInfo));
}
