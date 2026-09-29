import { createAuthClient } from "better-auth/react";
import { managedAuthExpoClient } from "@runablehq/managed-auth/native";
import { expoClient } from "@better-auth/expo/client";
import * as SecureStore from "expo-secure-store";
import Constants from "expo-constants";
import { Platform } from "react-native";

// Platform-managed identity: never edit `expo.extra` or `expo.scheme` in app.json.
const extra = (Constants.expoConfig?.extra ?? {}) as {
  apiUrl?: string;
  applicationId?: string;
  runableAuthIssuer?: string;
};

export const authClient = createAuthClient({
  baseURL: process.env.EXPO_PUBLIC_API_URL ?? extra.apiUrl,
  basePath: "/api/auth",
  plugins: [
    managedAuthExpoClient({
      applicationId: extra.applicationId as string,
      issuer: extra.runableAuthIssuer as string,
    }),
    // An email sign-in comes back as a Set-Cookie, and a phone has no cookie jar
    // to put it in. Without this the sign-in succeeds, the session is dropped on
    // the spot, and the crew get bounced back to the login screen. Keeps it in
    // the keychain instead, and hands it back through authClient.getCookie().
    // Native only: a browser keeps its own cookies, and there is no keychain.
    ...(Platform.OS === "web"
      ? []
      : [
          expoClient({
            scheme: Constants.expoConfig?.scheme as string,
            storage: {
              getItem: (key) => SecureStore.getItem(key),
              setItem: (key, value) => SecureStore.setItem(key, value),
            },
          }),
        ]),
  ],
});
