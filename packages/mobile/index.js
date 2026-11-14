// The app's front door (Damien, 14 Nov 2026). Same as expo-router's own,
// plus the Android widget redraw handler, which Android can call with Terra
// shut, so it has to be registered here rather than in a screen.
import "expo-router/entry";
import { Platform } from "react-native";
import { registerWidgetTaskHandler } from "react-native-android-widget";
import { widgetTaskHandler } from "./widgets/task-handler";

if (Platform.OS === "android") registerWidgetTaskHandler(widgetTaskHandler);
