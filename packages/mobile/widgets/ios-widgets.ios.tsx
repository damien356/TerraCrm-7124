import { HStack, Link, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import {
  containerBackground,
  font,
  foregroundStyle,
  lineLimit,
  minimumScaleFactor,
  padding,
  truncationMode,
  widgetURL,
} from "@expo/ui/swift-ui/modifiers";
import { createWidget, type WidgetEnvironment } from "expo-widgets";
import type { MyJobProps, TodayProps } from "../lib/widget-model";

/**
 * THE IPHONE WIDGETS (Damien, 14 Nov 2026). One medium size each.
 *
 * Each function below is lifted out by the 'widget' directive and run inside
 * the widget on its own, so it may not use anything from outside its own
 * body: no imports beyond the SwiftUI views and modifiers, no constants from
 * this file, no hooks. Everything it shows comes in as props worked out by
 * lib/widget-model.ts, and the names must match app.json.
 *
 * Text styles follow the iPhone's text size setting. Colours follow light
 * and dark mode. When nothing has synced yet, props are empty and a made-up
 * example is drawn, marked "Example".
 */

const TerraToday = (props: TodayProps, environment: WidgetEnvironment) => {
  "widget";
  const dark = environment.colorScheme === "dark";
  const bg = dark ? "#1F1E1C" : "#FFFFFF";
  const fg = dark ? "#F7F5F2" : "#1C1B1A";
  const muted = dark ? "#A39C95" : "#7A736D";
  const accent = dark ? "#D9713F" : "#C05A2B";
  const home = "runable-terraop-l8jfdfu://";

  const p: TodayProps =
    props && props.state
      ? props
      : {
          state: "example",
          message: null,
          tapUrl: home,
          updated: "Example",
          booking: { badge: "Today", isNow: false, when: "9:30 am", kind: "Measure", ref: "100001-A", suburb: "Sampletown", url: home },
          bookingNote: null,
          attention: { total: 5, summary: "Needs a body 2 · Overdue 3", url: home },
        };

  const one = (style: "headline" | "subheadline" | "footnote" | "caption" | "caption2", colour: string, weight?: "semibold" | "bold") => [
    font({ textStyle: style, weight }),
    foregroundStyle(colour),
    lineLimit(1),
    minimumScaleFactor(0.75),
    truncationMode("tail"),
  ];

  const header = (
    <HStack spacing={6}>
      <Text modifiers={one("caption", accent, "bold")}>TERRA TODAY</Text>
      <Spacer />
      <Text modifiers={one("caption2", muted)}>{p.updated}</Text>
    </HStack>
  );

  if (p.message && p.state !== "example") {
    return (
      <VStack alignment="leading" spacing={6} modifiers={[containerBackground(bg, "widget"), widgetURL(p.tapUrl)]}>
        {header}
        <Spacer />
        <Text modifiers={[font({ textStyle: "headline", weight: "semibold" }), foregroundStyle(fg), lineLimit(3), minimumScaleFactor(0.75)]}>
          {p.message}
        </Text>
        <Spacer />
      </VStack>
    );
  }

  const b = p.booking;
  const a = p.attention;
  return (
    <VStack alignment="leading" spacing={5} modifiers={[containerBackground(bg, "widget"), widgetURL(p.tapUrl)]}>
      {header}
      {p.bookingNote ? <Text modifiers={one("caption", muted)}>{p.bookingNote}</Text> : null}
      {b ? (
        <Link destination={b.url}>
          <VStack alignment="leading" spacing={1}>
            <HStack spacing={6}>
              <Text modifiers={one("headline", accent, "bold")}>{b.badge}</Text>
              <Text modifiers={one("headline", fg, "semibold")}>{b.when}</Text>
              <Spacer />
            </HStack>
            <Text modifiers={one("subheadline", fg)}>{`${b.kind} · ${b.ref} · ${b.suburb}`}</Text>
          </VStack>
        </Link>
      ) : null}
      <Spacer />
      {a ? (
        <Link destination={a.url}>
          <VStack alignment="leading" spacing={1}>
            <HStack spacing={6}>
              <Text modifiers={one("subheadline", fg, "semibold")}>Needs attention</Text>
              <Spacer />
              <Text modifiers={one("headline", a.total > 0 ? accent : muted, "bold")}>{String(a.total)}</Text>
            </HStack>
            <Text modifiers={one("caption", muted)}>{a.summary}</Text>
          </VStack>
        </Link>
      ) : null}
      {p.state === "example" ? <Text modifiers={one("caption2", muted)}>Open Terra to load your day</Text> : null}
    </VStack>
  );
};

const MyJob = (props: MyJobProps, environment: WidgetEnvironment) => {
  "widget";
  const dark = environment.colorScheme === "dark";
  const bg = dark ? "#1F1E1C" : "#FFFFFF";
  const fg = dark ? "#F7F5F2" : "#1C1B1A";
  const muted = dark ? "#A39C95" : "#7A736D";
  const accent = dark ? "#D9713F" : "#C05A2B";
  const amber = dark ? "#E0A33C" : "#9A6412";
  const home = "runable-terraop-l8jfdfu://";

  const p: MyJobProps =
    props && props.state
      ? props
      : {
          state: "example",
          message: null,
          tapUrl: home,
          updated: "Example",
          job: {
            badge: "Today",
            isNow: false,
            when: "7-11 am",
            kind: "Install",
            ref: "100001-B",
            suburb: "Sampletown",
            url: home,
            work: "Hybrid installation 40 m²",
            status: "Booked in",
            dayLabel: "Day 1 of 2",
            openUrl: home,
            directionsUrl: home,
            timeUrl: null,
          },
          jobNote: null,
          session: null,
          viewTodayUrl: null,
        };

  const one = (style: "headline" | "subheadline" | "footnote" | "caption" | "caption2", colour: string, weight?: "semibold" | "bold") => [
    font({ textStyle: style, weight }),
    foregroundStyle(colour),
    lineLimit(1),
    minimumScaleFactor(0.7),
    truncationMode("tail"),
  ];

  const header = (
    <HStack spacing={6}>
      <Text modifiers={one("caption", accent, "bold")}>MY JOB</Text>
      <Spacer />
      <Text modifiers={one("caption2", muted)}>{p.updated}</Text>
    </HStack>
  );

  if (p.message && p.state !== "example") {
    return (
      <VStack alignment="leading" spacing={6} modifiers={[containerBackground(bg, "widget"), widgetURL(p.tapUrl)]}>
        {header}
        <Spacer />
        <Text modifiers={[font({ textStyle: "headline", weight: "semibold" }), foregroundStyle(fg), lineLimit(3), minimumScaleFactor(0.75)]}>
          {p.message}
        </Text>
        <Spacer />
      </VStack>
    );
  }

  const j = p.job;
  return (
    <VStack alignment="leading" spacing={4} modifiers={[containerBackground(bg, "widget"), widgetURL(p.tapUrl)]}>
      {header}
      {p.jobNote ? <Text modifiers={one("caption", muted)}>{p.jobNote}</Text> : null}
      {j ? (
        <Link destination={j.openUrl}>
          <VStack alignment="leading" spacing={1}>
            <HStack spacing={6}>
              <Text modifiers={one("headline", accent, "bold")}>{j.badge}</Text>
              <Text modifiers={one("headline", fg, "semibold")}>{j.when}</Text>
              <Spacer />
              <Text modifiers={one("caption", muted)}>{j.status}</Text>
            </HStack>
            <Text modifiers={one("subheadline", fg, "semibold")}>
              {j.dayLabel ? `${j.ref} · ${j.suburb} · ${j.dayLabel}` : `${j.ref} · ${j.suburb}`}
            </Text>
            <Text modifiers={one("footnote", muted)}>{j.work}</Text>
          </VStack>
        </Link>
      ) : null}
      {p.session ? (
        <Link destination={p.session.url}>
          <Text modifiers={one("caption", amber, "semibold")}>{p.session.text}</Text>
        </Link>
      ) : null}
      <Spacer />
      <HStack spacing={14} modifiers={[padding({ top: 2 })]}>
        {j ? (
          <Link destination={j.openUrl}>
            <Text modifiers={one("footnote", accent, "semibold")}>Open job</Text>
          </Link>
        ) : (
          <Link destination={p.tapUrl}>
            <Text modifiers={one("footnote", accent, "semibold")}>Open Terra</Text>
          </Link>
        )}
        {j && j.directionsUrl ? (
          <Link destination={j.directionsUrl}>
            <Text modifiers={one("footnote", accent, "semibold")}>Directions</Text>
          </Link>
        ) : null}
        {j && j.timeUrl ? (
          <Link destination={j.timeUrl}>
            <Text modifiers={one("footnote", accent, "semibold")}>Time clock</Text>
          </Link>
        ) : null}
        {p.viewTodayUrl ? (
          <Link destination={p.viewTodayUrl}>
            <Text modifiers={one("footnote", accent, "semibold")}>View today</Text>
          </Link>
        ) : null}
        <Spacer />
      </HStack>
    </VStack>
  );
};

/** Names must match the expo-widgets entries in app.json. */
export const terraTodayWidget = createWidget("TerraToday", TerraToday);
export const myJobWidget = createWidget("MyJob", MyJob);
