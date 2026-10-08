import { useSafeAreaInsets } from "react-native-safe-area-context";

/**
 * Room to leave under anything pinned to the bottom of the screen.
 *
 * Android draws the app under its own buttons (back, home, recents), so a
 * bar at bottom 0 ends up behind them and can't be tapped. The inset is the
 * height of those buttons, or of the iPhone home bar. Never less than `min`,
 * so phones with no bar keep the old spacing.
 */
export function useBottomGap(min = 26, extra = 10) {
  const insets = useSafeAreaInsets();
  return Math.max(min, insets.bottom + extra);
}

/** The raw bottom inset, for padding scroll content clear of the bar. */
export function useBottomInset() {
  return useSafeAreaInsets().bottom;
}
