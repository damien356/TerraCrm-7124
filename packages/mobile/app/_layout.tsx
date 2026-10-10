// System-managed layout — extend in place, never rewrite from scratch.
// Keep the provider chain intact: ErrorBoundary → OneDollarStats → SafeArea → QueryClient.
// To switch navigation, replace only the <Slot /> line with <Stack /> or <Tabs />.
// First, before the sign-in client reads anything saved on the phone.
import {
  forgetSignedIn,
  hasSavedLogin,
  markReady,
  queueProblem,
  rememberSignedIn,
  setLoginNote,
  wasSignedIn,
} from "../lib/crash-guard";
import { useEffect, useRef, useState } from "react";
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
import { sendProblems } from "../lib/crash-report";
import { CannotReachScreen, StartupBoundary } from "../components/startup-screens";
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

  // No answer from the server (no signal, or Terra is down) while a login is
  // saved on the phone. That is not a sign-out: say so and offer Try again.
  const sessionError = session.error as { status?: number; message?: string } | null;
  const unreachable =
    !session.isPending &&
    !session.data &&
    !!sessionError &&
    (!sessionError.status || sessionError.status >= 500) &&
    hasSavedLogin();

  // The first screen is up: later crashes get the recovery screen, not a close.
  useEffect(() => {
    markReady();
  }, []);

  // Send any problems this phone kept, now and each time it comes back to the front.
  useEffect(() => {
    void sendProblems();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void sendProblems();
    });
    return () => sub.remove();
  }, []);

  // Remember a signed-in phone, so a login that later runs out can say so on Sign in.
  useEffect(() => {
    if (session.isPending || unreachable) return;
    if (session.data) {
      rememberSignedIn();
      void sendProblems();
      return;
    }
    if (!sessionError && wasSignedIn()) {
      setLoginNote("expired");
      queueProblem({ kind: "session_expired", message: "Saved login was no longer valid, sent to Sign in." });
      forgetSignedIn();
    }
  }, [session.isPending, session.data, sessionError, unreachable]);

  useEffect(() => {
    if (session.isPending || inCallback || unreachable) return;
    if (!session.data && !onLogin) router.replace("/login");
    if (session.data && onLogin) router.replace("/");
  }, [session.isPending, session.data, onLogin, inCallback, unreachable, router]);

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

  if (unreachable) {
    return (
      <CannotReachScreen
        onRetry={() => session.refetch()}
        detail={sessionError?.message ? `${sessionError.status ? `${sessionError.status} ` : ""}${sessionError.message}` : null}
      />
    );
  }

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
      <Stack.Screen name="task/swms/[id]" options={{ presentation: "card" }} />
      <Stack.Screen name="rate-card" options={{ presentation: "card" }} />
      <Stack.Screen name="voice-quote" options={{ presentation: "card", gestureEnabled: false }} />
      <Stack.Screen name="site-arrival" options={{ presentation: "card" }} />
    </Stack>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Poppins_400Regular,
    Poppins_500Medium,
    Poppins_600SemiBold,
  });
  // Fonts that never load (a bad update, a full phone) must not leave a
  // spinner up forever. After a few seconds go on with the phone's own font.
  const [fontWaitOver, setFontWaitOver] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setFontWaitOver(true), 4000);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    if (fontError) queueProblem({ kind: "error", message: `Fonts did not load. ${fontError.message}` });
  }, [fontError]);

  useEffect(() => {
    if (isWeb) startWebSafeArea();
  }, []);

  // Finishes a returning Expo Web sign-in. No-op on native.
  useEffect(() => {
    void authClient.managedAuth.handleRedirect();
  }, []);

  if (!fontsLoaded && !fontError && !fontWaitOver) {
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
            {/* Terra's own "hit a problem" screen, with Try again and Sign out. */}
            <StartupBoundary queryClient={queryClient}>
              <Navigation />
            </StartupBoundary>
          </QueryClientProvider>
        </SafeAreaProvider>
      </OneDollarStatsProvider>
    </ErrorBoundary>
  );
}
