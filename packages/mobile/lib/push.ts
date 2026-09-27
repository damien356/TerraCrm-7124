/* ---------------------------------------------------------------------------
 * Push notifications on the phone.
 *
 * Native only. The dashboard previews this app through Expo web, which has no
 * push service, so every call here no-ops off native and the preview keeps
 * working.
 * ------------------------------------------------------------------------- */

import { Platform } from "react-native";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import { client } from "./api";

export const pushSupported = Platform.OS === "ios" || Platform.OS === "android";

/** Banner, sound and badge even while the app is open. */
export function configureNotificationHandler() {
  if (!pushSupported) return;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
    }),
  });
}

async function androidChannel() {
  if (Platform.OS !== "android") return;
  await Notifications.setNotificationChannelAsync("default", {
    name: "Job alerts",
    importance: Notifications.AndroidImportance.MAX,
    vibrationPattern: [0, 250, 250, 250],
    lightColor: "#B45309",
    sound: "default",
  });
}

/**
 * Asks for permission, gets the Expo push token and tells the server about it.
 * Returns the token, or null when push isn't available or was refused.
 */
export async function registerForPush(): Promise<string | null> {
  if (!pushSupported || !Device.isDevice) return null;

  try {
    await androidChannel();

    const existing = await Notifications.getPermissionsAsync();
    let status = existing.status;
    if (status !== "granted") {
      const asked = await Notifications.requestPermissionsAsync();
      status = asked.status;
    }
    if (status !== "granted") return null;

    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId ?? undefined;

    const { data: token } = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined,
    );
    if (!token) return null;

    await client.devices.registerDevice({
      token,
      platform: Platform.OS === "ios" ? "ios" : "android",
      deviceName: Device.deviceName ?? Device.modelName ?? "",
      appVersion: Constants.expoConfig?.version ?? "",
    });

    return token;
  } catch (error) {
    console.warn("[push] registration failed", error);
    return null;
  }
}

/** Called on sign-out so a handed-on phone stops getting someone else's jobs. */
export async function unregisterPush(token: string | null) {
  if (!pushSupported || !token) return;
  try {
    await client.devices.unregisterDevice({ token });
  } catch (error) {
    console.warn("[push] unregister failed", error);
  }
}

/** Clears the little number on the app icon. */
export async function clearBadge() {
  if (!pushSupported) return;
  try {
    await Notifications.setBadgeCountAsync(0);
  } catch {
    // Not fatal.
  }
}

/**
 * Tapping a notification opens the thing it is about. Returns an unsubscribe.
 */
export function onNotificationTap(handler: (data: Record<string, unknown>) => void) {
  if (!pushSupported) return () => {};
  const sub = Notifications.addNotificationResponseReceivedListener((response) => {
    const data = (response.notification.request.content.data ?? {}) as Record<string, unknown>;
    handler(data);
  });
  return () => sub.remove();
}
