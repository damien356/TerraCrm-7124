import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import { Ionicons } from "@expo/vector-icons";
import { Fonts } from "@/constants/theme";

export type ViewerFile = {
  id: number;
  kind: string;
  url: string;
  filename: string | null;
  caption: string | null;
};

type Shown = "photo" | "video" | "pdf" | "other";

function shownAs(f: ViewerFile): Shown {
  if (f.kind === "photo") return "photo";
  if (f.kind === "video") return "video";
  return (f.filename ?? "").toLowerCase().endsWith(".pdf") ? "pdf" : "other";
}

const MAX_ZOOM = 5;

/**
 * Full screen viewer for one category of one job. Opens on the file that was
 * tapped and swipes through the rest of that category in thumbnail order.
 *
 * Photos zoom with a pinch (the iPhone's own scroll view zoom, no extra
 * library). While a photo is zoomed, swiping between files is switched off,
 * so dragging round a zoomed photo can never jump to the next one.
 *
 * PDFs and videos play in the page. Swiping is off on those too, so paging
 * through a plan never changes file. The arrows move between files.
 */
export function FileViewer({
  files,
  startIndex,
  title,
  onClose,
  refresh,
}: {
  files: ViewerFile[];
  startIndex: number;
  title: string;
  onClose: () => void;
  /** Fetches fresh links (signed links run out). */
  refresh: () => Promise<ViewerFile[] | undefined>;
}) {
  const { width, height } = useWindowDimensions();
  const listRef = useRef<FlatList<ViewerFile>>(null);
  const [index, setIndex] = useState(Math.min(Math.max(0, startIndex), Math.max(0, files.length - 1)));
  const [zoomed, setZoomed] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const [loaded, setLoaded] = useState<Record<number, boolean>>({});
  const [failed, setFailed] = useState<Record<number, boolean>>({});
  const [attempt, setAttempt] = useState<Record<number, number>>({});
  const [retrying, setRetrying] = useState(false);

  // Links stay put while open, so a background refetch never reloads the photo on screen.
  const urls = useRef(new Map<number, string>());
  for (const f of files) if (!urls.current.has(f.id)) urls.current.set(f.id, f.url);
  const urlOf = (f: ViewerFile) => urls.current.get(f.id) ?? f.url;

  const current = files[index];
  const kind = current ? shownAs(current) : "other";
  const swipeOn = kind === "photo" && !zoomed;

  // Only the neighbours are fetched ahead.
  useEffect(() => {
    for (const i of [index - 1, index + 1]) {
      const f = files[i];
      if (f && shownAs(f) === "photo" && !failed[f.id]) void Image.prefetch(urlOf(f)).catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, files]);

  useEffect(() => {
    if (files.length === 0) onClose();
  }, [files.length, onClose]);

  const goTo = useCallback(
    (next: number) => {
      if (next < 0 || next >= files.length || next === index) return;
      setZoomed(false);
      setResetKey((k) => k + 1);
      setIndex(next);
      listRef.current?.scrollToIndex({ index: next, animated: true });
    },
    [files.length, index],
  );

  const onSettled = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const next = Math.round(e.nativeEvent.contentOffset.x / Math.max(1, width));
    if (next !== index && next >= 0 && next < files.length) {
      setZoomed(false);
      setIndex(next);
    }
  };

  async function retry(id: number) {
    setRetrying(true);
    try {
      const fresh = await refresh();
      const again = fresh?.find((f) => f.id === id);
      if (again) urls.current.set(id, again.url);
    } catch {
      // Tries the old link again; the retry shows again if it fails.
    } finally {
      setFailed((f) => ({ ...f, [id]: false }));
      setLoaded((l) => ({ ...l, [id]: false }));
      setAttempt((a) => ({ ...a, [id]: (a[id] ?? 0) + 1 }));
      setRetrying(false);
    }
  }

  const pageH = height - 120;

  // A plain render function, not a component: a component made here would be
  // a new type every render and remount the page, losing the zoom.
  function renderPage(item: ViewerFile, i: number) {
    const k = shownAs(item);
    const url = urlOf(item);
    const tries = attempt[item.id] ?? 0;
    // Far pages are not drawn at all: the list only keeps a few alive.
    if (Math.abs(i - index) > 1) return <View style={{ width, height: pageH }} />;

    if (failed[item.id]) {
      return (
        <View style={{ width, height: pageH, alignItems: "center", justifyContent: "center", paddingHorizontal: 40, gap: 10 }}>
          <Text style={{ fontFamily: Fonts.bold, fontSize: 15, color: "#FFFFFF" }}>This file didn't load.</Text>
          <Text style={{ fontFamily: Fonts.sans, fontSize: 13, color: "rgba(255,255,255,0.65)", textAlign: "center" }}>
            Check your signal and try again. You can still move to the other files.
          </Text>
          <View style={{ flexDirection: "row", gap: 10, marginTop: 6 }}>
            <Pressable
              disabled={retrying}
              onPress={() => void retry(item.id)}
              style={{ backgroundColor: "#FFFFFF", borderRadius: 9, paddingHorizontal: 14, paddingVertical: 9, opacity: retrying ? 0.6 : 1 }}
            >
              <Text style={{ fontFamily: Fonts.bold, fontSize: 13, color: "#111111" }}>{retrying ? "Trying…" : "Try again"}</Text>
            </Pressable>
            <Pressable
              onPress={() => void Linking.openURL(url)}
              style={{ borderWidth: 1, borderColor: "rgba(255,255,255,0.4)", borderRadius: 9, paddingHorizontal: 14, paddingVertical: 9 }}
            >
              <Text style={{ fontFamily: Fonts.medium, fontSize: 13, color: "#FFFFFF" }}>Open</Text>
            </Pressable>
          </View>
        </View>
      );
    }

    if (k === "photo") {
      return (
        <ScrollView
          key={`${item.id}-${tries}-${i === index ? resetKey : 0}`}
          style={{ width, height: pageH }}
          contentContainerStyle={{ width, height: pageH, alignItems: "center", justifyContent: "center" }}
          minimumZoomScale={1}
          maximumZoomScale={MAX_ZOOM}
          centerContent
          bouncesZoom
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
          scrollEventThrottle={32}
          onScroll={(e) => {
            if (i !== index) return;
            const z = (e.nativeEvent as NativeScrollEvent & { zoomScale?: number }).zoomScale ?? 1;
            const now = z > 1.01;
            if (now !== zoomed) setZoomed(now);
          }}
        >
          {!loaded[item.id] ? <ActivityIndicator color="#FFFFFF" style={{ position: "absolute" }} /> : null}
          <Image
            source={{ uri: url }}
            resizeMode="contain"
            style={{ width, height: pageH }}
            onLoad={() => setLoaded((l) => ({ ...l, [item.id]: true }))}
            onError={() => setFailed((f) => ({ ...f, [item.id]: true }))}
            accessibilityLabel={item.caption ?? item.filename ?? "Job photo"}
          />
        </ScrollView>
      );
    }

    if ((k === "video" || k === "pdf") && Platform.OS !== "web") {
      const html =
        k === "video"
          ? `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#111;display:flex;align-items:center;justify-content:center;height:100vh"><video src="${url.replace(/"/g, "&quot;")}" controls playsinline preload="metadata" style="max-width:100%;max-height:100%"></video></body></html>`
          : null;
      return (
        <View style={{ width, height: pageH, paddingHorizontal: k === "pdf" ? 8 : 0 }}>
          <WebView
            key={`${item.id}-${tries}`}
            source={html ? { html } : { uri: url }}
            originWhitelist={["*"]}
            allowsInlineMediaPlayback
            mediaPlaybackRequiresUserAction
            style={{ flex: 1, backgroundColor: "#111111" }}
            startInLoadingState
            renderLoading={() => <ActivityIndicator color="#FFFFFF" style={{ position: "absolute", top: "50%", alignSelf: "center" }} />}
            onError={() => setFailed((f) => ({ ...f, [item.id]: true }))}
            onHttpError={() => setFailed((f) => ({ ...f, [item.id]: true }))}
          />
        </View>
      );
    }

    return (
      <View style={{ width, height: pageH, alignItems: "center", justifyContent: "center", gap: 12, paddingHorizontal: 40 }}>
        <Ionicons name="document-outline" size={46} color="rgba(255,255,255,0.6)" />
        <Text numberOfLines={1} style={{ fontFamily: Fonts.medium, fontSize: 14, color: "#FFFFFF" }}>
          {item.caption || item.filename || "File"}
        </Text>
        <Text style={{ fontFamily: Fonts.sans, fontSize: 12.5, color: "rgba(255,255,255,0.6)" }}>No preview for this file.</Text>
        <Pressable
          onPress={() => void Linking.openURL(url)}
          style={{ backgroundColor: "#FFFFFF", borderRadius: 9, paddingHorizontal: 14, paddingVertical: 9 }}
        >
          <Text style={{ fontFamily: Fonts.bold, fontSize: 13, color: "#111111" }}>Open or download</Text>
        </Pressable>
      </View>
    );
  }

  const arrow = (dir: -1 | 1) => {
    const off = dir < 0 ? index === 0 : index >= files.length - 1;
    return (
      <Pressable
        accessibilityLabel={dir < 0 ? "Previous file" : "Next file"}
        disabled={off}
        onPress={() => goTo(index + dir)}
        hitSlop={10}
        style={{ padding: 10, borderRadius: 999, backgroundColor: "rgba(255,255,255,0.12)", opacity: off ? 0.25 : 1 }}
      >
        <Ionicons name={dir < 0 ? "chevron-back" : "chevron-forward"} size={22} color="#FFFFFF" />
      </Pressable>
    );
  };

  return (
    <Modal visible animationType="fade" presentationStyle="fullScreen" onRequestClose={onClose} supportedOrientations={["portrait", "landscape"]}>
      <SafeAreaView style={{ flex: 1, backgroundColor: "#111111" }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingVertical: 10 }}>
          <View style={{ flex: 1 }}>
            <Text numberOfLines={1} style={{ fontFamily: Fonts.bold, fontSize: 15, color: "#FFFFFF" }}>
              {title}
              <Text style={{ fontFamily: Fonts.sans, color: "rgba(255,255,255,0.7)" }}>{`  ${files.length ? index + 1 : 0} of ${files.length}`}</Text>
            </Text>
            <Text numberOfLines={1} style={{ fontFamily: Fonts.sans, fontSize: 12, color: "rgba(255,255,255,0.6)", marginTop: 1 }}>
              {current?.caption || current?.filename || ""}
            </Text>
          </View>
          {zoomed ? (
            <Pressable
              onPress={() => {
                setZoomed(false);
                setResetKey((k) => k + 1);
              }}
              hitSlop={8}
              style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: "rgba(255,255,255,0.12)" }}
            >
              <Text style={{ fontFamily: Fonts.medium, fontSize: 12.5, color: "#FFFFFF" }}>Reset zoom</Text>
            </Pressable>
          ) : null}
          {current ? (
            <Pressable accessibilityLabel="Open" onPress={() => void Linking.openURL(urlOf(current))} hitSlop={8} style={{ padding: 6 }}>
              <Ionicons name="open-outline" size={21} color="#FFFFFF" />
            </Pressable>
          ) : null}
          <Pressable accessibilityLabel="Close" onPress={onClose} hitSlop={10} style={{ padding: 6 }}>
            <Ionicons name="close" size={26} color="#FFFFFF" />
          </Pressable>
        </View>

        <FlatList
          ref={listRef}
          data={files}
          keyExtractor={(f) => String(f.id)}
          horizontal
          pagingEnabled
          scrollEnabled={swipeOn}
          initialScrollIndex={index}
          getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
          initialNumToRender={1}
          windowSize={3}
          maxToRenderPerBatch={2}
          showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={onSettled}
          extraData={[index, zoomed, loaded, failed, attempt, resetKey, retrying]}
          renderItem={({ item, index: i }) => renderPage(item, i)}
        />

        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 18, paddingVertical: 10 }}>
          {arrow(-1)}
          <Text style={{ fontFamily: Fonts.sans, fontSize: 12, color: "rgba(255,255,255,0.55)" }}>
            {kind === "photo" ? (zoomed ? "Drag to look round. Reset zoom to swipe." : "Swipe or pinch") : kind === "pdf" ? "Scroll for pages. Arrows for files." : "Arrows for files"}
          </Text>
          {arrow(1)}
        </View>
      </SafeAreaView>
    </Modal>
  );
}
