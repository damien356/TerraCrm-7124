import { useState } from "react";
import { ActivityIndicator, Image, Linking, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { Colors, Fonts } from "@/constants/theme";
import { uploadToStorage } from "@/lib/upload";
import { useAddMedia, useJobFile, useNoDamage } from "@/queries/field";

const c = Colors.light;

/**
 * THE JOB FILE on the phone. Named buckets, never a diary. Plans are read-only
 * (the office owns those); everything else the crew adds to and can't delete.
 */
const BUCKETS = [
  { key: "plan", label: "Plans", icon: "document-text-outline", blurb: "What you're working off." },
  { key: "access", label: "Site access", icon: "key-outline", blurb: "Parking, lift, gate code, stairs." },
  { key: "area", label: "Areas", icon: "grid-outline", blurb: "Room by room. Shoot what you're covering." },
  { key: "damage", label: "Damage", icon: "warning-outline", blurb: "Anything already wrong, BEFORE you start." },
  { key: "found", label: "What we found", icon: "search-outline", blurb: "Subfloor, moisture, nasties. Office gets told." },
  { key: "completion", label: "Completion", icon: "checkmark-done-outline", blurb: "Finished work. Needed to close the job." },
  { key: "defect", label: "Defects", icon: "build-outline", blurb: "Callbacks and fixes." },
  /* Callback visits only. Both are read only on the phone. */
  { key: "client_reported", label: "Client photos", icon: "chatbubble-ellipses-outline", blurb: "What the client sent in about the problem." },
  { key: "original", label: "Original job", icon: "time-outline", blurb: "Photos from the first visit. Read only." },
] as const;

type BucketKey = (typeof BUCKETS)[number]["key"];
/** The office owns these. The crew looks, never adds. */
const READ_ONLY = ["plan", "client_reported", "original"] as const;
type CrewBucket = Exclude<BucketKey, (typeof READ_ONLY)[number]>;
const isReadOnly = (b: BucketKey) => (READ_ONLY as readonly string[]).includes(b);
const CALLBACK_ONLY = ["client_reported", "original"] as const;

/** Longest side a job photo is kept at. Sharp on any screen, about a fifth of the size. */
const MAX_EDGE = 2048;

/**
 * Phone cameras shoot 4000px and up. Shrink to MAX_EDGE and save as JPEG
 * (which also turns iPhone HEIC into something every browser shows), so each
 * photo is a few hundred KB instead of several MB. If the shrink fails for any
 * reason, the original goes up instead.
 */
async function shrinkPhoto(asset: ImagePicker.ImagePickerAsset): Promise<{ uri: string }> {
  try {
    const ctx = ImageManipulator.manipulate(asset.uri);
    const w = asset.width ?? 0;
    const h = asset.height ?? 0;
    if (w > MAX_EDGE || h > MAX_EDGE) {
      ctx.resize(w >= h ? { width: MAX_EDGE } : { height: MAX_EDGE });
    }
    const img = await ctx.renderAsync();
    const out = await img.saveAsync({ compress: 0.75, format: SaveFormat.JPEG });
    return { uri: out.uri };
  } catch {
    return { uri: asset.uri };
  }
}

export function JobFileSection({
  taskId,
  jobId,
  areaId,
}: {
  taskId: number;
  jobId: number;
  areaId?: number | null;
}) {
  const file = useJobFile(taskId);
  const addMedia = useAddMedia();
  const noDamage = useNoDamage();

  const [bucket, setBucket] = useState<BucketKey>("area");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [failed, setFailed] = useState<{
    assets: ImagePicker.ImagePickerAsset[];
    video: boolean;
    bucket: CrewBucket;
  } | null>(null);

  const media = file.data?.media ?? [];
  const meta = BUCKETS.find((b) => b.key === bucket)!;
  const items = media.filter((m) => m.bucket === bucket);
  const gates = file.data?.gates;

  async function uploadOne(asset: ImagePicker.ImagePickerAsset, video: boolean, target: CrewBucket) {
    const isVideo = video || asset.type === "video";
    const ready = isVideo ? { uri: asset.uri } : await shrinkPhoto(asset);
    const filename = isVideo
      ? (asset.fileName ?? `${target}-${Date.now()}.mp4`)
      : `${(asset.fileName ?? `${target}-${Date.now()}`).replace(/\.[^.]+$/, "")}.jpg`;
    const contentType = isVideo ? (asset.mimeType ?? "video/mp4") : "image/jpeg";
    const { key, sizeBytes } = await uploadToStorage({ uri: ready.uri, jobId, bucket: target, filename, contentType });
    await addMedia.mutateAsync({
      taskId,
      bucket: target,
      kind: isVideo ? "video" : "photo",
      storageKey: key,
      filename,
      mime: contentType,
      sizeBytes,
      durationSeconds: asset.duration != null ? asset.duration / 1000 : null,
      areaId: target === "area" ? (areaId ?? null) : null,
    });
  }

  /** Up to 3 at once, so a dozen photos is a short wait, not a long one. */
  async function uploadAll(assets: ImagePicker.ImagePickerAsset[], video: boolean, target: CrewBucket) {
    setBusy(true);
    setFailed(null);
    setProgress({ done: 0, total: assets.length });
    const missed: ImagePicker.ImagePickerAsset[] = [];
    let done = 0;
    let next = 0;
    const worker = async () => {
      while (next < assets.length) {
        const asset = assets[next++]!;
        try {
          await uploadOne(asset, video, target);
        } catch {
          missed.push(asset);
        }
        done += 1;
        setProgress({ done, total: assets.length });
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(3, assets.length) }, worker));
      if (missed.length) {
        setFailed({ assets: missed, video, bucket: target });
        setError(
          missed.length === assets.length
            ? "That didn't upload. Try again when you've got signal."
            : `${assets.length - missed.length} of ${assets.length} went up. ${missed.length} didn't. Tap Try again when you've got signal.`,
        );
      }
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  async function capture(source: "camera" | "library", video: boolean, into?: BucketKey) {
    // `into` is for buttons that switch tab and shoot in one tap; state has not updated yet.
    const target = into ?? bucket;
    if (isReadOnly(target)) return;
    setError(null);
    try {
      const fromLibrary = !(source === "camera" && Platform.OS !== "web");
      const opts: ImagePicker.ImagePickerOptions = {
        mediaTypes: video ? ["videos"] : ["images"],
        // Photos are shrunk here before upload, so take them at full quality.
        quality: video ? 0.7 : 1,
        videoMaxDuration: 60,
        // Pick a whole batch from the gallery in one go.
        allowsMultipleSelection: fromLibrary && !video,
        selectionLimit: fromLibrary && !video ? 30 : 1,
        orderedSelection: true,
      };
      const res = fromLibrary
        ? await ImagePicker.launchImageLibraryAsync(opts)
        : await ImagePicker.launchCameraAsync(opts);
      if (res.canceled || res.assets.length === 0) return;
      await uploadAll(res.assets, video, target as CrewBucket);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't upload. Try again when you've got signal.");
    }
  }

  return (
    <View style={{ marginTop: 22 }}>
      <Text style={{ fontFamily: Fonts.medium, fontSize: 10.5, letterSpacing: 1.2, color: c.mutedForeground }}>
        JOB FILE
      </Text>

      {gates && !gates.damageDone ? (
        <View
          style={{
            backgroundColor: "#FBEDD8",
            borderRadius: 12,
            padding: 13,
            marginTop: 9,
          }}
        >
          <Text style={{ fontFamily: Fonts.bold, fontSize: 14, color: "#8A5A11" }}>Walk the site first</Text>
          <Text style={{ fontFamily: Fonts.sans, fontSize: 13, color: "#8A5A11", marginTop: 3, lineHeight: 18 }}>
            Photograph anything already damaged before you start, like scratched skirting, cracked tiles, marked walls. If
            it's all clean, tick it off. You can't start the job until one of those is done.
          </Text>
          <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
            <Pressable
              onPress={() => {
                setBucket("damage");
                void capture("camera", false, "damage");
              }}
              style={{ backgroundColor: "#8A5A11", borderRadius: 9, paddingHorizontal: 13, paddingVertical: 9 }}
            >
              <Text style={{ fontFamily: Fonts.bold, fontSize: 12.5, color: "#FFFFFF" }}>Add damage photo</Text>
            </Pressable>
            <Pressable
              onPress={() => void noDamage.mutateAsync({ taskId })}
              style={{
                borderWidth: 1,
                borderColor: "#8A5A11",
                borderRadius: 9,
                paddingHorizontal: 13,
                paddingVertical: 9,
              }}
            >
              <Text style={{ fontFamily: Fonts.bold, fontSize: 12.5, color: "#8A5A11" }}>Nothing found</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 10 }}>
        <View style={{ flexDirection: "row", gap: 7 }}>
          {BUCKETS.map((b) => {
            const on = b.key === bucket;
            const count = media.filter((m) => m.bucket === b.key).length;
            if ((CALLBACK_ONLY as readonly string[]).includes(b.key) && !file.data?.isCallback && count === 0) return null;
            return (
              <Pressable
                key={b.key}
                onPress={() => setBucket(b.key)}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 6,
                  backgroundColor: on ? c.sidebar : c.card,
                  borderWidth: 1,
                  borderColor: on ? c.sidebar : c.border,
                  borderRadius: 999,
                  paddingHorizontal: 12,
                  paddingVertical: 8,
                }}
              >
                <Ionicons name={b.icon} size={14} color={on ? c.primary : c.mutedForeground} />
                <Text style={{ fontFamily: Fonts.medium, fontSize: 12.5, color: on ? "#FFFFFF" : c.foreground }}>
                  {b.label}
                </Text>
                <Text style={{ fontFamily: Fonts.bold, fontSize: 11.5, color: on ? c.primary : c.mutedForeground }}>
                  {count}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>

      <Text style={{ fontFamily: Fonts.sans, fontSize: 12.5, color: c.mutedForeground, marginTop: 9 }}>
        {meta.blurb}
        {bucket === "completion" && gates
          ? ` ${gates.completionHave}/${gates.completionNeeded} added.`
          : ""}
      </Text>

      {!isReadOnly(bucket) ? (
        <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
          <Pressable
            disabled={busy}
            onPress={() => void capture("camera", false)}
            style={{
              flex: 1,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              backgroundColor: c.primary,
              borderRadius: 11,
              paddingVertical: 12,
              opacity: busy ? 0.6 : 1,
            }}
          >
            <Ionicons name="camera-outline" size={16} color="#FFFFFF" />
            <Text style={{ fontFamily: Fonts.bold, fontSize: 13.5, color: "#FFFFFF" }}>Photo</Text>
          </Pressable>
          <Pressable
            disabled={busy}
            onPress={() => void capture("camera", true)}
            style={{
              flex: 1,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              borderWidth: 1,
              borderColor: c.border,
              borderRadius: 11,
              paddingVertical: 12,
              opacity: busy ? 0.6 : 1,
            }}
          >
            <Ionicons name="videocam-outline" size={16} color={c.foreground} />
            <Text style={{ fontFamily: Fonts.medium, fontSize: 13.5, color: c.foreground }}>Video</Text>
          </Pressable>
          <Pressable
            disabled={busy}
            onPress={() => void capture("library", false)}
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              borderWidth: 1,
              borderColor: c.border,
              borderRadius: 11,
              paddingHorizontal: 14,
              paddingVertical: 12,
              opacity: busy ? 0.6 : 1,
            }}
          >
            <Ionicons name="images-outline" size={16} color={c.foreground} />
          </Pressable>
        </View>
      ) : null}

      {busy ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 10 }}>
          <ActivityIndicator color={c.primary} />
          <Text style={{ fontFamily: Fonts.sans, fontSize: 12.5, color: c.mutedForeground }}>
            {progress && progress.total > 1 ? `Uploading ${progress.done} of ${progress.total}…` : "Uploading…"}
          </Text>
        </View>
      ) : null}

      {error ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginTop: 8 }}>
          <Text style={{ flex: 1, fontFamily: Fonts.medium, fontSize: 12.5, color: c.destructive }}>{error}</Text>
          {failed && !busy ? (
            <Pressable
              onPress={() => {
                const f = failed;
                setError(null);
                void uploadAll(f.assets, f.video, f.bucket);
              }}
              style={{ borderWidth: 1, borderColor: c.destructive, borderRadius: 9, paddingHorizontal: 12, paddingVertical: 7 }}
            >
              <Text style={{ fontFamily: Fonts.bold, fontSize: 12.5, color: c.destructive }}>Try again</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
        {items.length === 0 ? (
          <Text style={{ fontFamily: Fonts.sans, fontSize: 13, color: c.mutedForeground }}>
            Nothing in here yet.
          </Text>
        ) : (
          items.map((m) => (
            <Pressable
              key={m.id}
              onPress={() => void Linking.openURL(m.url)}
              style={{
                width: 96,
                height: 96,
                borderRadius: 11,
                overflow: "hidden",
                backgroundColor: c.secondary,
                borderWidth: 1,
                borderColor: c.border,
              }}
            >
              {m.kind === "photo" ? (
                <Image source={{ uri: m.url }} style={{ width: "100%", height: "100%" }} resizeMode="cover" />
              ) : (
                <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 4 }}>
                  <Ionicons name={m.kind === "video" ? "play-circle-outline" : "document-outline"} size={26} color={c.mutedForeground} />
                  <Text style={{ fontFamily: Fonts.medium, fontSize: 10.5, color: c.mutedForeground }}>
                    {m.kind === "video" ? "Video" : "File"}
                  </Text>
                </View>
              )}
            </Pressable>
          ))
        )}
      </View>
    </View>
  );
}
