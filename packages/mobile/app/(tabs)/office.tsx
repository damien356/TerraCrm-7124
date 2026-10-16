import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, BackHandler, Linking, Platform, Pressable, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { WebView, type WebViewNavigation } from "react-native-webview";
import { Colors, Fonts } from "@/constants/theme";
import { siteUrl } from "@/lib/api";
import { sessionTokenForWebPages } from "@/lib/auth";
import { useWhoami } from "@/queries/session";

const c = Colors.light;

/** Where the website keeps its sign-in token. Same key the website's own sign-in uses. */
const WEB_TOKEN_KEY = "runable.managed-auth.token";

function originOf(url: string) {
  const m = /^(https?:\/\/[^/?#]+)/i.exec(url);
  return m ? m[1].toLowerCase() : "";
}

/** The site address with the phone flag on, for the first page the app opens. */
function pageUrl(path: string) {
  const clean = path.startsWith("/") ? path : `/${path}`;
  const joiner = clean.includes("?") ? "&" : "?";
  return `${siteUrl}${clean}${joiner}app=1`;
}

/**
 * Runs before the website's own code on every page it loads. Marks the page
 * as the phone app and hands it this phone's sign-in, only ever on Terra's
 * own address.
 */
function bootScript(token: string | null) {
  return `(function(){try{
if (window.location.origin.toLowerCase() !== ${JSON.stringify(originOf(siteUrl))}) return;
window.__TERRA_PHONE_APP__ = true;
window.__TERRA_APP_MENU__ = true;
var t = ${JSON.stringify(token ?? "")};
if (t) { window.localStorage.setItem(${JSON.stringify(WEB_TOKEN_KEY)}, t); }
else { window.localStorage.removeItem(${JSON.stringify(WEB_TOKEN_KEY)}); }
}catch(e){}})();true;`;
}

function HeaderButton({
  icon,
  label,
  onPress,
  solid,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  solid?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel={label}
      hitSlop={4}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        minHeight: 44,
        minWidth: 44,
        paddingHorizontal: solid ? 14 : 10,
        paddingVertical: 8,
        borderRadius: 999,
        backgroundColor: solid ? c.primary : "transparent",
        opacity: pressed ? 0.75 : 1,
      })}
    >
      <Ionicons name={icon} size={solid ? 17 : 21} color={solid ? "#FFFFFF" : "rgba(255,255,255,0.85)"} />
      {solid ? <Text style={{ fontFamily: Fonts.bold, fontSize: 13.5, color: "#FFFFFF" }}>{label}</Text> : null}
    </Pressable>
  );
}

function Centre({ children }: { children: React.ReactNode }) {
  return <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>{children}</View>;
}

/**
 * The office side of the app (notes 18.44). Admin and Office logins get the
 * website's own pages here, phone sized, with the cut-down phone menu. The
 * website decides what that menu holds and keeps price edits and schedule
 * moves off, so every website publish updates this screen too.
 */
export default function OfficeScreen() {
  const router = useRouter();
  const who = useWhoami();
  const isOffice = who.data?.canSeeOffice === true;
  const params = useLocalSearchParams<{ path?: string; at?: string }>();
  const web = useRef<WebView>(null);
  const [canGoBack, setCanGoBack] = useState(false);
  const [firstLoad, setFirstLoad] = useState(true);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // The first page is fixed once. A later "open this quote" goes in as a
  // navigation, so the page keeps its place in the back history.
  const [startPath] = useState(() => (typeof params.path === "string" && params.path ? params.path : "/"));
  const token = useMemo(() => sessionTokenForWebPages(), []);
  const boot = useMemo(() => bootScript(token), [token]);
  const site = originOf(siteUrl);

  const lastAsk = useRef(params.at);
  useEffect(() => {
    if (!params.path || params.at === lastAsk.current) return;
    lastAsk.current = params.at;
    web.current?.injectJavaScript(`window.location.assign(${JSON.stringify(pageUrl(params.path))});true;`);
  }, [params.path, params.at]);

  // Android back steps back through the pages before it leaves the tab.
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== "android") return undefined;
      const sub = BackHandler.addEventListener("hardwareBackPress", () => {
        if (!canGoBack) return false;
        web.current?.goBack();
        return true;
      });
      return () => sub.remove();
    }, [canGoBack]),
  );

  const onNav = useCallback((nav: WebViewNavigation) => setCanGoBack(nav.canGoBack), []);

  /** Terra pages stay in here. Anything else (maps, phone, email, files) opens in its own app. */
  const keepInside = useCallback(
    (req: { url: string; isTopFrame?: boolean }) => {
      const url = req.url;
      if (req.isTopFrame === false) return true;
      if (url.startsWith("about:") || url.startsWith("blob:") || url.startsWith("data:")) return true;
      if (originOf(url) === site) return true;
      void Linking.openURL(url).catch(() => undefined);
      return false;
    },
    [site],
  );

  const reload = useCallback(() => {
    // After a failure, or before the first page ever landed, start clean.
    if (failed || firstLoad) {
      setFailed(false);
      setAttempt((n) => n + 1);
      return;
    }
    web.current?.reload();
  }, [failed, firstLoad]);

  // The website's own menu drawer, opened from this bar so the page needs no second header.
  const openMenu = useCallback(() => {
    web.current?.injectJavaScript("window.__terraOpenMenu&&window.__terraOpenMenu();true;");
  }, []);

  const header = (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        paddingHorizontal: 6,
        paddingVertical: 2,
        backgroundColor: c.sidebar,
      }}
    >
      {Platform.OS !== "web" ? <HeaderButton icon="menu" label="Menu" onPress={openMenu} /> : null}
      {canGoBack ? <HeaderButton icon="chevron-back" label="Back" onPress={() => web.current?.goBack()} /> : null}
      <Text style={{ flex: 1, fontFamily: Fonts.bold, fontSize: 15, color: "#FFFFFF", marginLeft: 4 }}>The office</Text>
      <HeaderButton icon="refresh" label="Reload" onPress={reload} />
      <HeaderButton icon="mic" label="Voice quote" solid onPress={() => router.push("/voice-quote")} />
    </View>
  );

  if (who.isLoading) {
    return (
      <SafeAreaView edges={["top", "left", "right"]} style={{ flex: 1, backgroundColor: c.background }}>
        <Centre>
          <ActivityIndicator color={c.primary} />
        </Centre>
      </SafeAreaView>
    );
  }

  if (!isOffice) {
    return (
      <SafeAreaView edges={["top", "left", "right"]} style={{ flex: 1, backgroundColor: c.background }}>
        <Centre>
          <Ionicons name="lock-closed-outline" size={26} color={c.mutedForeground} />
          <Text style={{ fontFamily: Fonts.sans, fontSize: 14, color: c.mutedForeground, textAlign: "center", marginTop: 10 }}>
            This screen is for the office. Your login is set up as crew.
          </Text>
        </Centre>
      </SafeAreaView>
    );
  }

  // A browser preview cannot hold one site inside another. Open it in a tab instead.
  if (Platform.OS === "web") {
    return (
      <SafeAreaView edges={["top", "left", "right"]} style={{ flex: 1, backgroundColor: c.sidebar }}>
        {header}
        <View style={{ flex: 1, backgroundColor: c.background }}>
          <Centre>
            <Ionicons name="phone-portrait-outline" size={28} color={c.mutedForeground} />
            <Text style={{ fontFamily: Fonts.bold, fontSize: 17, color: c.foreground, marginTop: 10 }}>
              Office pages open on the phone
            </Text>
            <Text
              style={{ fontFamily: Fonts.sans, fontSize: 13.5, lineHeight: 19, color: c.mutedForeground, textAlign: "center", marginTop: 6 }}
            >
              On a phone they show right here. In this preview, open them in a new tab to see the phone menu.
            </Text>
            <Pressable
              onPress={() => void Linking.openURL(pageUrl(startPath))}
              style={({ pressed }) => ({
                marginTop: 16,
                backgroundColor: c.primary,
                borderRadius: 12,
                paddingVertical: 12,
                paddingHorizontal: 18,
                opacity: pressed ? 0.85 : 1,
              })}
            >
              <Text style={{ fontFamily: Fonts.bold, fontSize: 14.5, color: "#FFFFFF" }}>Open the office pages</Text>
            </Pressable>
          </Centre>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={["top", "left", "right"]} style={{ flex: 1, backgroundColor: c.sidebar }}>
      {header}
      <View style={{ flex: 1, backgroundColor: c.background }}>
        {failed ? (
          <Centre>
            <Ionicons name="cloud-offline-outline" size={28} color={c.mutedForeground} />
            <Text style={{ fontFamily: Fonts.bold, fontSize: 17, color: c.foreground, marginTop: 10 }}>
              Could not reach the office
            </Text>
            <Text style={{ fontFamily: Fonts.sans, fontSize: 13.5, color: c.mutedForeground, textAlign: "center", marginTop: 6 }}>
              Check the phone has signal, then try again.
            </Text>
            <Pressable
              onPress={reload}
              style={({ pressed }) => ({
                marginTop: 16,
                backgroundColor: c.primary,
                borderRadius: 12,
                paddingVertical: 12,
                paddingHorizontal: 22,
                opacity: pressed ? 0.85 : 1,
              })}
            >
              <Text style={{ fontFamily: Fonts.bold, fontSize: 14.5, color: "#FFFFFF" }}>Try again</Text>
            </Pressable>
          </Centre>
        ) : (
          <WebView
            key={attempt}
            ref={web}
            source={{ uri: pageUrl(startPath) }}
            applicationNameForUserAgent="TerraOpsApp/1"
            injectedJavaScriptBeforeContentLoaded={boot}
            onShouldStartLoadWithRequest={keepInside}
            onNavigationStateChange={onNav}
            onLoadEnd={() => setFirstLoad(false)}
            onError={() => setFailed(true)}
            onHttpError={(e) => {
              if (e.nativeEvent.statusCode >= 500) setFailed(true);
            }}
            onOpenWindow={(e) => {
              const url = e.nativeEvent.targetUrl;
              if (originOf(url) === site) web.current?.injectJavaScript(`window.location.assign(${JSON.stringify(url)});true;`);
              else void Linking.openURL(url).catch(() => undefined);
            }}
            setSupportMultipleWindows={false}
            scalesPageToFit={false}
            setBuiltInZoomControls={false}
            setDisplayZoomControls={false}
            textZoom={100}
            pullToRefreshEnabled
            allowsBackForwardNavigationGestures
            sharedCookiesEnabled
            domStorageEnabled
            javaScriptEnabled
            startInLoadingState
            renderLoading={() => (
              <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center", backgroundColor: c.background }}>
                <ActivityIndicator color={c.primary} />
                <Text style={{ fontFamily: Fonts.sans, fontSize: 13, color: c.mutedForeground, marginTop: 10 }}>
                  Opening the office
                </Text>
              </View>
            )}
            style={{ flex: 1, backgroundColor: c.background }}
          />
        )}
      </View>
    </SafeAreaView>
  );
}
