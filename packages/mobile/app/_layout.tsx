// System-managed layout — extend in place, never rewrite from scratch.
// Keep the provider chain intact: ErrorBoundary → OneDollarStats → SafeArea → QueryClient.
// To switch navigation, replace only the <Slot /> line with <Stack /> or <Tabs />.
import { useEffect, useRef } from "react";
import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useFonts } from "expo-font";
import {
  Poppins_400Regular,
  Poppins_500Medium,
  Poppins_600SemiBold,
} from "@expo-google-fonts/poppins";
import { ActivityIndicator, AppState, View } from "react-native";
import { ErrorBoundary } from "../components/__ErrorBoundary";
import { OneDollarStatsProvider } from "../lib/__analytics";
import { isWeb, startWebSafeArea } from "../lib/__web-safe-area";
import { authClient } from "../lib/auth";
import {
  clearBadge,
  configureNotificationHandler,
  onNotificationTap,
  pushSupported,
  registerForPush,
} from "../lib/push";
import { stageUpdate, updatesSupported } from "../lib/updates";
// Defines the background geofence task at load, so iOS can wake Terra straight into it.
import { fencesSupported, syncSiteFences } from "../lib/site-fences";
import { useWhoami } from "../queries/session";
import { Colors } from "../constants/theme";
import appJson from "../app.json";

const queryClient = new QueryClient();

// Banner, sound and badge even while the app is open. Native only.
configureNotificationHandler();

const applicationId = appJson.expo.extra.applicationId ?? "";
const hostname = applicationId ? `${applicationId}-mobile` : "localhost";

/** Signed-out installers get bounced to the login screen, signed-in ones off it. */
function Navigation() {
  const session = authClient.useSession();
  const segments = useSegments();
  const router = useRouter();
  const who = useWhoami();
  const pushToken = useRef<string | null>(null);
  const landed = useRef(false);

  const signedInAs = session.data?.user?.id ?? null;
  const onLogin = segments[0] === "login";
  const inCallback = segments[0] === "auth";

  useEffect(() => {
    if (session.isPending || inCallback) return;
    if (!session.data && !onLogin) router.replace("/login");
    if (session.data && onLogin) router.replace("/");
  }, [session.isPending, session.data, onLogin, inCallback, router]);

  // An office login with no installer card behind it has no crew screens to
  // show, so it opens on the Office tab instead of an empty Today.
  useEffect(() => {
    if (!session.data || !who.data || landed.current) return;
    if (who.data.canSeeOffice && !who.data.canSeeField) {
      landed.current = true;
      router.replace("/office");
    }
  }, [session.data, who.data, router]);

  // Register this phone for push once signed in, and clear the icon badge.
  useEffect(() => {
    if (!session.data || !pushSupported) return;
    void registerForPush().then((token) => {
      pushToken.current = token;
    });
    void clearBadge();
  }, [session.data]);

  // Point the site circles at today's and tomorrow's jobs, once signed in and
  // every time Terra comes back to the front. Does nothing unless the
  // installer switched on arriving by location.
  useEffect(() => {
    if (!signedInAs || !fencesSupported) return;
    void syncSiteFences();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void syncSiteFences();
    });
    return () => sub.remove();
  }, [signedInAs]);

  // Look for a new over-the-air build when the app comes back to the front, and
  // stage it quietly. It takes effect on the next cold start, so nobody loses
  // what they were typing. Phones that sit open for days still catch up.
  useEffect(() => {
    if (!updatesSupported) return;
    void stageUpdate();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void stageUpdate();
    });
    return () => sub.remove();
  }, []);

  // Tapping an alert opens the job it is about.
  useEffect(() => {
    if (!pushSupported) return;
    return onNotificationTap((data) => {
      const taskId = Number(data.taskId);
      if (Number.isFinite(taskId) && taskId > 0) router.push(`/task/${taskId}`);
      void clearBadge();
    });
  }, [router]);

  if (session.isPending) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: Colors.light.sidebar,
        }}
      >
        <ActivityIndicator color={Colors.light.primary} />
      </View>
    );
  }

  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: Colors.light.background } }}>
      <Stack.Screen name="login" />
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="task/[id]" options={{ presentation: "card" }} />
      <Stack.Screen name="task/invoice/[id]" options={{ presentation: "card" }} />
      <Stack.Screen name="rate-card" options={{ presentation: "card" }} />
      <Stack.Screen name="voice-quote" options={{ presentation: "card", gestureEnabled: false }} />
      <Stack.Screen name="site-arrival" options={{ presentation: "card" }} />
    </Stack>
  );
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    Poppins_400Regular,
    Poppins_500Medium,
    Poppins_600SemiBold,
  });

  useEffect(() => {
    if (isWeb) startWebSafeArea();
  }, []);

  // Finishes a returning Expo Web sign-in. No-op on native.
  useEffect(() => {
    void authClient.managedAuth.handleRedirect();
  }, []);

  if (!fontsLoaded) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: Colors.light.sidebar,
        }}
      >
        <ActivityIndicator color={Colors.light.primary} />
      </View>
    );
  }

  return (
    <ErrorBoundary>
      {/* Runable analytics provider — do not remove, required for analytics tracking */}
      <OneDollarStatsProvider
        config={{
          hostname,
          collectorUrl: "https://r.lilstts.com/events",
          devmode: true,
        }}
      >
        <SafeAreaProvider>
          <QueryClientProvider client={queryClient}>
            <StatusBar style="auto" />
            <Navigation />
          </QueryClientProvider>
        </SafeAreaProvider>
      </OneDollarStatsProvider>
    </ErrorBoundary>
  );
}
