import { FlexWidget, TextWidget, type WidgetRepresentation } from "react-native-android-widget";
import type { MyJobProps, TodayProps } from "../lib/widget-model";

/**
 * THE ANDROID WIDGETS (Damien, 14 Nov 2026). One layout each that stretches.
 *
 * Drawn from the same words as the iPhone ones (lib/widget-model.ts). The
 * widget can be resized on the home screen, so lines drop away as it gets
 * smaller: the work and the open-session line go first when it is short,
 * and the extra buttons go when it is narrow. Text follows the phone's text
 * size setting and never runs past one or two lines.
 *
 * Every tap opens Terra at a screen. Nothing here starts or stops a timer.
 */

type Hex = `#${string}`;
interface Palette {
  bg: Hex;
  fg: Hex;
  muted: Hex;
  accent: Hex;
  amber: Hex;
  line: Hex;
}

const LIGHT: Palette = { bg: "#FFFFFF", fg: "#1C1B1A", muted: "#7A736D", accent: "#C05A2B", amber: "#9A6412", line: "#ECE7E1" };
const DARK: Palette = { bg: "#1F1E1C", fg: "#F7F5F2", muted: "#A39C95", accent: "#D9713F", amber: "#E0A33C", line: "#34312E" };

export interface WidgetSize {
  width: number;
  height: number;
}

const open = (uri: string) => ({ clickAction: "OPEN_URI" as const, clickActionData: { uri } });

function Line(props: { text: string; size: number; colour: Hex; bold?: boolean; lines?: number; uri?: string }) {
  return (
    <TextWidget
      text={props.text}
      maxLines={props.lines ?? 1}
      truncate="END"
      allowFontScaling
      style={{ fontSize: props.size, color: props.colour, fontWeight: props.bold ? "bold" : "normal" }}
      {...(props.uri ? open(props.uri) : {})}
    />
  );
}

function Frame(props: { c: Palette; title: string; updated: string; tapUrl: string; children: any }) {
  return (
    <FlexWidget
      {...open(props.tapUrl)}
      style={{
        height: "match_parent",
        width: "match_parent",
        flexDirection: "column",
        backgroundColor: props.c.bg,
        borderRadius: 18,
        padding: 12,
      }}
    >
      <FlexWidget style={{ width: "match_parent", flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Line text={props.title} size={11} colour={props.c.accent} bold />
        <Line text={props.updated} size={10} colour={props.c.muted} />
      </FlexWidget>
      {props.children}
    </FlexWidget>
  );
}

function Message(props: { c: Palette; text: string }) {
  return (
    <FlexWidget style={{ flex: 1, width: "match_parent", justifyContent: "center" }}>
      <Line text={props.text} size={15} colour={props.c.fg} bold lines={3} />
    </FlexWidget>
  );
}

function Button(props: { c: Palette; text: string; uri: string }) {
  return (
    <FlexWidget
      {...open(props.uri)}
      style={{ paddingVertical: 4, paddingHorizontal: 8, marginRight: 6, borderRadius: 10, borderWidth: 1, borderColor: props.c.line }}
    >
      <Line text={props.text} size={12} colour={props.c.accent} bold />
    </FlexWidget>
  );
}

function todayBody(p: TodayProps, c: Palette, size: WidgetSize) {
  if (p.message && p.state !== "example") return <Message c={c} text={p.message} />;
  const short = size.height < 120;
  const b = p.booking;
  const a = p.attention;
  return (
    <FlexWidget style={{ flex: 1, width: "match_parent", flexDirection: "column", justifyContent: "space-between", marginTop: 4 }}>
      <FlexWidget style={{ width: "match_parent", flexDirection: "column" }}>
        {p.bookingNote ? <Line text={p.bookingNote} size={11} colour={c.muted} /> : null}
        {b ? (
          <FlexWidget {...open(b.url)} style={{ width: "match_parent", flexDirection: "column" }}>
            <FlexWidget style={{ flexDirection: "row" }}>
              <Line text={`${b.badge}  `} size={15} colour={c.accent} bold />
              <Line text={b.when} size={15} colour={c.fg} bold />
            </FlexWidget>
            <Line text={`${b.kind} · ${b.ref} · ${b.suburb}`} size={13} colour={c.fg} />
          </FlexWidget>
        ) : null}
      </FlexWidget>
      {a ? (
        <FlexWidget {...open(a.url)} style={{ width: "match_parent", flexDirection: "column", borderTopWidth: 1, borderTopColor: c.line, paddingTop: 4 }}>
          <FlexWidget style={{ width: "match_parent", flexDirection: "row", justifyContent: "space-between" }}>
            <Line text="Needs attention" size={13} colour={c.fg} bold />
            <Line text={String(a.total)} size={15} colour={a.total > 0 ? c.accent : c.muted} bold />
          </FlexWidget>
          {short ? null : <Line text={a.summary} size={11} colour={c.muted} />}
        </FlexWidget>
      ) : null}
      {p.state === "example" ? <Line text="Open Terra to load your day" size={10} colour={c.muted} /> : null}
    </FlexWidget>
  );
}

function jobBody(p: MyJobProps, c: Palette, size: WidgetSize) {
  if (p.message && p.state !== "example") return <Message c={c} text={p.message} />;
  const short = size.height < 120;
  const narrow = size.width < 230;
  const j = p.job;
  const buttons: { text: string; uri: string }[] = [];
  buttons.push(j ? { text: "Open job", uri: j.openUrl } : { text: "Open Terra", uri: p.tapUrl });
  if (j?.directionsUrl) buttons.push({ text: "Directions", uri: j.directionsUrl });
  if (j?.timeUrl) buttons.push({ text: "Time clock", uri: j.timeUrl });
  if (p.viewTodayUrl) buttons.push({ text: "View today", uri: p.viewTodayUrl });
  const shown = buttons.slice(0, narrow ? 2 : 4);

  return (
    <FlexWidget style={{ flex: 1, width: "match_parent", flexDirection: "column", justifyContent: "space-between", marginTop: 4 }}>
      <FlexWidget style={{ width: "match_parent", flexDirection: "column" }}>
        {p.jobNote ? <Line text={p.jobNote} size={11} colour={c.muted} /> : null}
        {j ? (
          <FlexWidget {...open(j.openUrl)} style={{ width: "match_parent", flexDirection: "column" }}>
            <FlexWidget style={{ width: "match_parent", flexDirection: "row", justifyContent: "space-between" }}>
              <FlexWidget style={{ flexDirection: "row" }}>
                <Line text={`${j.badge}  `} size={15} colour={c.accent} bold />
                <Line text={j.when} size={15} colour={c.fg} bold />
              </FlexWidget>
              <Line text={j.status} size={11} colour={c.muted} />
            </FlexWidget>
            <Line text={j.dayLabel ? `${j.ref} · ${j.suburb} · ${j.dayLabel}` : `${j.ref} · ${j.suburb}`} size={13} colour={c.fg} bold />
            {short ? null : <Line text={j.work} size={12} colour={c.muted} lines={size.height >= 170 ? 2 : 1} />}
          </FlexWidget>
        ) : null}
        {p.session && !short ? <Line text={p.session.text} size={11} colour={c.amber} bold uri={p.session.url} /> : null}
      </FlexWidget>
      <FlexWidget style={{ width: "match_parent", flexDirection: "row", marginTop: 4 }}>
        {shown.map((b) => (
          <Button key={b.text} c={c} text={b.text} uri={b.uri} />
        ))}
      </FlexWidget>
    </FlexWidget>
  );
}

export function TerraTodayAndroid(p: TodayProps, size: WidgetSize): WidgetRepresentation {
  const draw = (c: Palette) => (
    <Frame c={c} title="TERRA TODAY" updated={p.updated} tapUrl={p.tapUrl}>
      {todayBody(p, c, size)}
    </Frame>
  );
  return { light: draw(LIGHT), dark: draw(DARK) };
}

export function MyJobAndroid(p: MyJobProps, size: WidgetSize): WidgetRepresentation {
  const draw = (c: Palette) => (
    <Frame c={c} title="MY JOB" updated={p.updated} tapUrl={p.tapUrl}>
      {jobBody(p, c, size)}
    </Frame>
  );
  return { light: draw(LIGHT), dark: draw(DARK) };
}

/** Names must match the react-native-android-widget entries in app.json. */
export const ANDROID_WIDGETS = { today: "TerraToday", job: "MyJob" } as const;
