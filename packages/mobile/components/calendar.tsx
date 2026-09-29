import { Pressable, Text, View } from "react-native";
import { Colors, Fonts } from "@/constants/theme";
import { dayOfMonth, monthGrid, monthLabel, todayISO, WEEKDAY_SHORT } from "@/lib/format";

const c = Colors.light;

type ViewMode = "day" | "week" | "month";

export function ViewModeToggle({ value, onChange }: { value: ViewMode; onChange: (v: ViewMode) => void }) {
  const options: ViewMode[] = ["day", "week", "month"];
  return (
    <View
      style={{
        flexDirection: "row",
        backgroundColor: c.card,
        borderWidth: 1,
        borderColor: c.border,
        borderRadius: 12,
        padding: 3,
      }}
    >
      {options.map((opt) => {
        const active = opt === value;
        return (
          <Pressable
            key={opt}
            onPress={() => onChange(opt)}
            style={{
              flex: 1,
              paddingVertical: 8,
              borderRadius: 9,
              alignItems: "center",
              backgroundColor: active ? c.sidebar : "transparent",
            }}
          >
            <Text
              style={{
                fontFamily: Fonts.medium,
                fontSize: 12.5,
                color: active ? "#FFFFFF" : c.mutedForeground,
                textTransform: "capitalize",
              }}
            >
              {opt}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A dot under a day that has work, coloured, count on top when there's more than one. */
function DayDot({ count }: { count: number }) {
  if (count === 0) return <View style={{ height: 6 }} />;
  return (
    <View
      style={{
        marginTop: 3,
        minWidth: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: c.primary,
        paddingHorizontal: count > 1 ? 3 : 0,
      }}
    />
  );
}

/** 7 day strip, Monday first, the selected day and days with work coloured. */
export function WeekStrip({
  weekStart,
  selected,
  onSelect,
  countsByDate,
}: {
  weekStart: string;
  selected: string;
  onSelect: (iso: string) => void;
  countsByDate: Map<string, number>;
}) {
  const days: string[] = [];
  let cursor = weekStart;
  for (let i = 0; i < 7; i++) {
    days.push(cursor);
    const d = new Date(cursor);
    cursor = new Date(d.getTime() + 86400_000).toISOString().slice(0, 10);
  }
  const today = todayISO();
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
      {days.map((iso, idx) => {
        const isSelected = iso === selected;
        const isToday = iso === today;
        const count = countsByDate.get(iso) ?? 0;
        return (
          <Pressable
            key={iso}
            onPress={() => onSelect(iso)}
            style={{
              alignItems: "center",
              paddingVertical: 8,
              width: 42,
              borderRadius: 12,
              backgroundColor: isSelected ? c.sidebar : "transparent",
            }}
          >
            <Text
              style={{
                fontFamily: Fonts.medium,
                fontSize: 10.5,
                color: isSelected ? "rgba(255,255,255,0.6)" : c.mutedForeground,
              }}
            >
              {WEEKDAY_SHORT[idx]}
            </Text>
            <Text
              style={{
                fontFamily: isToday ? Fonts.bold : Fonts.medium,
                fontSize: 15,
                marginTop: 2,
                color: isSelected ? "#FFFFFF" : isToday ? c.primary : c.foreground,
              }}
            >
              {dayOfMonth(iso)}
            </Text>
            <DayDot count={count} />
          </Pressable>
        );
      })}
    </View>
  );
}

/** Full month grid, Monday first, days outside the month dimmed, work days coloured. */
export function MonthGrid({
  anchor,
  selected,
  onSelect,
  countsByDate,
}: {
  anchor: string;
  selected: string;
  onSelect: (iso: string) => void;
  countsByDate: Map<string, number>;
}) {
  const cells = monthGrid(anchor);
  const today = todayISO();
  const rows: (typeof cells)[] = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));

  return (
    <View>
      <Text style={{ fontFamily: Fonts.bold, fontSize: 15, color: c.foreground, marginBottom: 10 }}>
        {monthLabel(anchor)}
      </Text>
      <View style={{ flexDirection: "row", marginBottom: 4 }}>
        {WEEKDAY_SHORT.map((w) => (
          <Text
            key={w}
            style={{
              flex: 1,
              textAlign: "center",
              fontFamily: Fonts.medium,
              fontSize: 10.5,
              color: c.mutedForeground,
            }}
          >
            {w}
          </Text>
        ))}
      </View>
      {rows.map((row, ri) => (
        <View key={ri} style={{ flexDirection: "row" }}>
          {row.map((cell) => {
            const isSelected = cell.date === selected;
            const isToday = cell.date === today;
            const count = countsByDate.get(cell.date) ?? 0;
            const hasWork = count > 0;
            return (
              <Pressable
                key={cell.date}
                onPress={() => onSelect(cell.date)}
                style={{ flex: 1, alignItems: "center", paddingVertical: 7 }}
              >
                <View
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: 15,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: isSelected ? c.sidebar : hasWork ? c.accent : "transparent",
                    borderWidth: isToday && !isSelected ? 1 : 0,
                    borderColor: c.primary,
                  }}
                >
                  <Text
                    style={{
                      fontFamily: hasWork || isToday ? Fonts.bold : Fonts.sans,
                      fontSize: 13,
                      color: isSelected
                        ? "#FFFFFF"
                        : !cell.inMonth
                          ? c.mutedForeground
                          : hasWork
                            ? c.primary
                            : c.foreground,
                      opacity: cell.inMonth ? 1 : 0.4,
                    }}
                  >
                    {dayOfMonth(cell.date)}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}
