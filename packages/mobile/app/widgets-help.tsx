import { Platform, Pressable, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useBottomInset } from "@/hooks/use-bottom-gap";
import { Colors, Fonts } from "@/constants/theme";

const c = Colors.light;

/**
 * HOW TO ADD THE HOME-SCREEN WIDGETS (Damien, 14 Nov 2026).
 * Opened from the Me tab. Plain steps for the phone in hand.
 */

const IPHONE = [
  "Touch and hold an empty part of your home screen until the apps wiggle.",
  "Tap Edit, then Add Widget (or the + at the top).",
  "Search for Terra.",
  "Pick Terra Today or My Job, then tap Add Widget.",
];

const ANDROID = [
  "Touch and hold an empty part of your home screen.",
  "Tap Widgets.",
  "Find Terra in the list.",
  "Touch and hold Terra Today or My Job and drag it where you want it. You can stretch it once it is placed.",
];

function Steps({ steps }: { steps: string[] }) {
  return (
    <View style={{ gap: 10 }}>
      {steps.map((s, i) => (
        <View key={s} style={{ flexDirection: "row", gap: 10 }}>
          <View
            style={{
              width: 24,
              height: 24,
              borderRadius: 12,
              backgroundColor: c.primary,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text style={{ fontFamily: Fonts.bold, fontSize: 12.5, color: c.primaryForeground }}>{i + 1}</Text>
          </View>
          <Text style={{ flex: 1, fontFamily: Fonts.sans, fontSize: 14.5, lineHeight: 21, color: c.foreground }}>{s}</Text>
        </View>
      ))}
    </View>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <View style={{ backgroundColor: c.card, borderWidth: 1, borderColor: c.border, borderRadius: 14, padding: 14, marginTop: 14 }}>
      {children}
    </View>
  );
}

function Title({ text }: { text: string }) {
  return <Text style={{ fontFamily: Fonts.bold, fontSize: 15.5, color: c.foreground, marginBottom: 10 }}>{text}</Text>;
}

function Point({ text }: { text: string }) {
  return <Text style={{ fontFamily: Fonts.sans, fontSize: 14, lineHeight: 20, color: c.foreground, marginTop: 6 }}>{`•  ${text}`}</Text>;
}

export default function WidgetsHelpScreen() {
  const router = useRouter();
  const bottomInset = useBottomInset();
  const iphone = Platform.OS === "ios";

  return (
    <SafeAreaView edges={["top", "left", "right"]} style={{ flex: 1, backgroundColor: c.background }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12 }}>
        <Pressable onPress={() => router.back()} style={{ padding: 4 }} accessibilityLabel="Back">
          <Ionicons name="chevron-back" size={24} color={c.foreground} />
        </Pressable>
        <Text style={{ fontFamily: Fonts.bold, fontSize: 19, color: c.foreground }}>Home-screen widgets</Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 0, paddingBottom: 40 + bottomInset }}>
        <Text style={{ fontFamily: Fonts.sans, fontSize: 14.5, lineHeight: 21, color: c.mutedForeground }}>
          See what is next without opening Terra. Tap a line on the widget to go straight to it.
        </Text>

        <Card>
          <Title text="Which one?" />
          <Point text="Terra Today, for the office: the next booking and what needs attention." />
          <Point text="My Job, for installers: your next job, with Open job, Directions and Time clock." />
        </Card>

        <Card>
          <Title text={iphone ? "Add it on your iPhone" : "Add it on your Android phone"} />
          <Steps steps={iphone ? IPHONE : ANDROID} />
        </Card>

        <Card>
          <Title text="Good to know" />
          <Point text="Open Terra once first, then add the widget. Before that it only shows an example." />
          <Point text="It is not live. It updates each time Terra opens and shows when it last did." />
          <Point text="If it has been too long, it asks you to open Terra to refresh." />
          <Point text="Time clock opens your hours screen. It never starts your time by itself." />
          <Point text="It never shows prices, pay, customer names, phone numbers or street addresses." />
          <Point text="Signing out of Terra clears it straight away." />
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}
