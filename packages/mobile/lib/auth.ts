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

// A native sign-in gets its session back as a Set-Cookie and expoClient below
// tucks it into SecureStore. The Expo web preview has no cookie jar of its own
// for that: it serves the app and the API off two different sandbox
// subdomains, and a browser refuses a cross-site cookie either way. Better
// Auth's own answer to that is the bearer plugin (enabled server-side): sign-in
// also comes back with a "set-auth-token" header, and replaying that as
// "Authorization: Bearer <token>" on every later request works from any
// origin. These two helpers are that token's only home on web.
const WEB_TOKEN_KEY = "terra-ops.session-token";

export function getWebSessionToken(): string | null {
  if (Platform.OS !== "web" || typeof localStorage === "undefined") return null;
  return localStorage.getItem(WEB_TOKEN_KEY);
}

function setWebSessionToken(token: string | null) {
  if (Platform.OS !== "web" || typeof localStorage === "undefined") return;
  if (token) localStorage.setItem(WEB_TOKEN_KEY, token);
  else localStorage.removeItem(WEB_TOKEN_KEY);
}

export const authClient = createAuthClient({
  baseURL: process.env.EXPO_PUBLIC_API_URL ?? extra.apiUrl,
  basePath: "/api/auth",
  fetchOptions: {
    // Sends the stored token back on every request this client makes
    // (get-session, sign-out, ...). A missing token just sends no header.
    auth: Platform.OS === "web" ? { type: "Bearer", token: () => getWebSessionToken() ?? "" } : undefined,
    onSuccess(context) {
      if (Platform.OS !== "web") return;
      const url = context.request.url.toString();
      const issuedToken = context.response.headers.get("set-auth-token");
      if (issuedToken) setWebSessionToken(issuedToken);
      if (url.includes("/sign-out")) setWebSessionToken(null);
    },
  },
  plugins: [
    managedAuthExpoClient({
      applicationId: extra.applicationId as string,
      issuer: extra.runableAuthIssuer as string,
    }),
    // Native only: an email sign-in comes back as a Set-Cookie, and this keeps
    // it in the keychain instead, handing it back through authClient.getCookie().
    expoClient({
      scheme: Constants.expoConfig?.scheme as string,
      storage: {
        getItem: (key) => SecureStore.getItem(key),
        setItem: (key, value) => SecureStore.setItem(key, value),
      },
    }),
  ],
});
