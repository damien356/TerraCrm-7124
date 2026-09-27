import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { View, Text } from "react-native";
import { useColors } from "@/hooks/use-colors";
import { Fonts } from "@/constants/theme";
import { useOffers } from "@/queries/field";
import { useWhoami } from "@/queries/session";

function OfferBadge({ color }: { color: string }) {
  const offers = useOffers();
  const count = offers.data?.length ?? 0;
  if (count === 0) return null;
  return (
    <View
      style={{
        position: "absolute",
        top: -4,
        right: -10,
        minWidth: 16,
        height: 16,
        borderRadius: 8,
        paddingHorizontal: 4,
        backgroundColor: color,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text style={{ fontFamily: Fonts.bold, fontSize: 10, color: "#FFFFFF" }}>{count}</Text>
    </View>
  );
}

export default function TabLayout() {
  const colors = useColors();
  const who = useWhoami();

  // One app, two sides. The office tab only exists on an admin login, and the
  // crew tabs only on a login with an installer card behind it. The server
  // gates every route as well, so this is presentation, not security.
  const isAdmin = who.data?.canSeeOffice === true;
  const isCrew = who.data?.canSeeField === true;
  const crewTab = isCrew || who.isLoading ? undefined : null;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.mutedForeground,
        tabBarLabelStyle: { fontFamily: Fonts.medium, fontSize: 11 },
        tabBarStyle: {
          backgroundColor: colors.card,
          borderTopColor: colors.border,
          height: 60,
          paddingTop: 6,
          paddingBottom: 6,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          href: crewTab,
          title: "Today",
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? "today" : "today-outline"} size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="schedule"
        options={{
          href: crewTab,
          title: "Coming up",
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? "calendar" : "calendar-outline"} size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="offers"
        options={{
          href: crewTab,
          title: "Offers",
          tabBarIcon: ({ color, size, focused }) => (
            <View>
              <Ionicons name={focused ? "notifications" : "notifications-outline"} size={size} color={color} />
              <OfferBadge color={colors.primary} />
            </View>
          ),
        }}
      />
      <Tabs.Screen
        name="office"
        options={{
          href: isAdmin ? undefined : null,
          title: "Office",
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? "business" : "business-outline"} size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="me"
        options={{
          title: "Me",
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? "person" : "person-outline"} size={size} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
