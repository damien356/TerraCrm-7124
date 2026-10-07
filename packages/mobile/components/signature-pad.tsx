import { useRef, useState } from "react";
import { PanResponder, Pressable, Text, View, type LayoutChangeEvent } from "react-native";
import { Colors, Fonts } from "@/constants/theme";

const c = Colors.light;
const INK = "#14204D";
const THICK = 2.4;

export type SignatureValue = { w: number; h: number; strokes: number[][] };

/**
 * Finger signature with plain Views, no drawing library, so it ships as an
 * over-the-air update. The server gets the raw strokes (pad size plus x,y
 * points) and draws them into the PDF itself.
 */
export function SignaturePad({
  onChange,
  onDrawingChange,
  height = 170,
}: {
  onChange: (sig: SignatureValue | null) => void;
  /** True while a finger is down, so the screen can stop scrolling. */
  onDrawingChange?: (drawing: boolean) => void;
  height?: number;
}) {
  const size = useRef({ w: 0, h: height });
  const strokes = useRef<number[][]>([]);
  const [, redraw] = useState(0);

  const emit = () => {
    const s = strokes.current.filter((x) => x.length >= 2);
    onChange(s.length ? { w: size.current.w, h: size.current.h, strokes: s.map((x) => [...x]) } : null);
  };

  const clamp = (v: number, max: number) => Math.max(0, Math.min(max, v));

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,
      onPanResponderGrant: (e) => {
        onDrawingChange?.(true);
        const { locationX, locationY } = e.nativeEvent;
        strokes.current.push([clamp(locationX, size.current.w), clamp(locationY, size.current.h)]);
        redraw((n) => n + 1);
      },
      onPanResponderMove: (e) => {
        const s = strokes.current[strokes.current.length - 1];
        if (!s) return;
        const x = clamp(e.nativeEvent.locationX, size.current.w);
        const y = clamp(e.nativeEvent.locationY, size.current.h);
        const px = s[s.length - 2]!;
        const py = s[s.length - 1]!;
        // Skip tiny moves: fewer Views, smoother on older phones.
        if (Math.hypot(x - px, y - py) < 2.5 || s.length >= 3990) return;
        s.push(x, y);
        redraw((n) => n + 1);
      },
      onPanResponderRelease: () => {
        onDrawingChange?.(false);
        emit();
      },
      onPanResponderTerminate: () => {
        onDrawingChange?.(false);
        emit();
      },
    }),
  ).current;

  function clear() {
    strokes.current = [];
    redraw((n) => n + 1);
    onChange(null);
  }

  function onLayout(e: LayoutChangeEvent) {
    size.current = { w: Math.round(e.nativeEvent.layout.width), h: Math.round(e.nativeEvent.layout.height) };
  }

  const segments: React.ReactNode[] = [];
  strokes.current.forEach((s, si) => {
    if (s.length === 2) {
      segments.push(
        <View
          key={`d${si}`}
          style={{
            position: "absolute",
            left: s[0]! - THICK / 2,
            top: s[1]! - THICK / 2,
            width: THICK,
            height: THICK,
            borderRadius: THICK / 2,
            backgroundColor: INK,
          }}
        />,
      );
      return;
    }
    for (let i = 2; i + 1 < s.length; i += 2) {
      const x1 = s[i - 2]!;
      const y1 = s[i - 1]!;
      const x2 = s[i]!;
      const y2 = s[i + 1]!;
      const len = Math.hypot(x2 - x1, y2 - y1) + THICK * 0.6;
      const angle = Math.atan2(y2 - y1, x2 - x1);
      segments.push(
        <View
          key={`${si}-${i}`}
          style={{
            position: "absolute",
            left: (x1 + x2) / 2 - len / 2,
            top: (y1 + y2) / 2 - THICK / 2,
            width: len,
            height: THICK,
            borderRadius: THICK / 2,
            backgroundColor: INK,
            transform: [{ rotate: `${angle}rad` }],
          }}
        />,
      );
    }
  });

  const empty = strokes.current.length === 0;

  return (
    <View>
      <View
        onLayout={onLayout}
        {...pan.panHandlers}
        style={{
          height,
          borderWidth: 1.5,
          borderColor: c.border,
          borderStyle: "dashed",
          borderRadius: 12,
          backgroundColor: "#FFFFFF",
          overflow: "hidden",
        }}
      >
        <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0 }}>
          <View
            style={{
              position: "absolute",
              left: 18,
              right: 18,
              bottom: 34,
              height: 1,
              backgroundColor: c.border,
            }}
          />
          {empty ? (
            <Text
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: height / 2 - 16,
                textAlign: "center",
                fontFamily: Fonts.sans,
                fontSize: 14,
                color: c.mutedForeground,
              }}
            >
              Sign here with your finger
            </Text>
          ) : null}
          {segments}
        </View>
      </View>
      <Pressable onPress={clear} hitSlop={8} style={{ alignSelf: "flex-end", marginTop: 6, paddingVertical: 4 }}>
        <Text style={{ fontFamily: Fonts.medium, fontSize: 13, color: c.primary }}>Clear</Text>
      </Pressable>
    </View>
  );
}
