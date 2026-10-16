import * as React from "react";
import { CalendarDays } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Damien, 16 Oct (notes 18.52): every date reads DD/MM/YYYY. A browser's own
 * date box follows the computer's language, so on a US set Mac or phone it
 * showed 10/16/2026. This box always shows 16/10/2026 and still hands the page
 * the same YYYY-MM-DD value the old date box did, so nothing else changes.
 *
 * Type the digits (the slashes go in by themselves) or tap the calendar.
 * `<Input type="date">` renders this, so every date box in Terra gets it.
 */

const pad = (n: number) => String(n).padStart(2, "0");

/** "2026-10-16" to "16/10/2026". Anything else to "". */
export function isoToAu(iso: string | null | undefined) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
}

/** "16/10/2026" to "2026-10-16". Null when it is not a real day. */
export function auToIso(text: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text.trim());
  if (!m) return null;
  const d = Number(m[1]);
  const mo = Number(m[2]);
  const y = Number(m[3]);
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  return `${y}-${pad(mo)}-${pad(d)}`;
}

/** Digits typed or pasted, shaped as DD/MM/YYYY while you type. */
function mask(raw: string) {
  const full = /^\s*(\d{1,2})[/.\- ](\d{1,2})[/.\- ](\d{4})\s*$/.exec(raw);
  if (full) return `${pad(Number(full[1]))}/${pad(Number(full[2]))}/${full[3]}`;
  const digits = raw.replace(/\D/g, "").slice(0, 8);
  if (digits.length <= 2) return digits + (raw.trim().endsWith("/") && digits.length === 2 ? "/" : "");
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
}

type Props = Omit<React.ComponentProps<"input">, "type">;

function fakeEvent(value: string, name?: string, id?: string) {
  const target = { value, name: name ?? "", id: id ?? "" };
  return { target, currentTarget: target } as unknown as React.ChangeEvent<HTMLInputElement> & React.FocusEvent<HTMLInputElement>;
}

export function DateField({
  className,
  value,
  defaultValue,
  onChange,
  onBlur,
  min,
  max,
  disabled,
  required,
  id,
  name,
  placeholder,
  ...rest
}: Props) {
  const controlled = value !== undefined;
  const [own, setOwn] = React.useState(String(defaultValue ?? ""));
  const iso = controlled ? String(value ?? "") : own;
  const [text, setText] = React.useState(isoToAu(iso));
  const picker = React.useRef<HTMLInputElement>(null);
  const lastIso = React.useRef(iso);

  // The page changed the date (a reset, a preset): show it.
  React.useEffect(() => {
    if (iso !== lastIso.current) {
      lastIso.current = iso;
      setText(isoToAu(iso));
    }
  }, [iso]);

  function emit(next: string) {
    if (next === lastIso.current) return;
    lastIso.current = next;
    if (!controlled) setOwn(next);
    onChange?.(fakeEvent(next, name, id));
  }

  function typed(raw: string) {
    const shaped = mask(raw);
    setText(shaped);
    if (shaped === "") return emit("");
    const next = auToIso(shaped);
    if (next) emit(next);
  }

  function left() {
    // A half typed or impossible date goes back to the last good one.
    const good = text === "" ? "" : auToIso(text);
    if (good === null) setText(isoToAu(lastIso.current));
    else setText(isoToAu(good));
    onBlur?.(fakeEvent(good ?? lastIso.current, name, id));
  }

  function picked(next: string) {
    setText(isoToAu(next));
    emit(next);
    // Boxes that save when you leave them save on a pick too.
    onBlur?.(fakeEvent(next, name, id));
  }

  function openPicker() {
    const el = picker.current;
    if (!el || disabled) return;
    try {
      el.showPicker();
    } catch {
      el.focus();
      el.click();
    }
  }

  // Width classes size the whole box (text and calendar button), the rest style the text.
  const tokens = (className ?? "").split(/\s+/).filter(Boolean);
  const sizing = tokens.filter((t) => /^(?:[a-z]+:)?(?:w-|max-w-|min-w-|flex-|shrink|grow|basis-)/.test(t));
  const look = tokens.filter((t) => !sizing.includes(t)).join(" ");

  return (
    <div className={cn("relative", sizing.length ? sizing.join(" ") : "w-full")}>
      <input
        {...rest}
        id={id}
        name={name}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        placeholder={placeholder ?? "DD/MM/YYYY"}
        maxLength={10}
        disabled={disabled}
        required={required}
        pattern="\d{2}/\d{2}/\d{4}"
        title="DD/MM/YYYY"
        value={text}
        onChange={(e) => typed(e.target.value)}
        onBlur={left}
        className={cn(
          "tabular h-9 w-full rounded-md border border-border bg-card pl-3 pr-9 text-sm outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-primary focus:ring-2 focus:ring-primary/15 disabled:opacity-50",
          look,
          "pr-9",
        )}
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label="Pick a date"
        disabled={disabled}
        onClick={openPicker}
        className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-muted-foreground hover:text-primary disabled:opacity-50"
      >
        <CalendarDays className="size-4" />
      </button>
      <input
        ref={picker}
        type="date"
        tabIndex={-1}
        aria-hidden
        min={min}
        max={max}
        value={iso}
        onChange={(e) => picked(e.target.value)}
        className="pointer-events-none absolute bottom-0 right-0 h-0 w-0 opacity-0"
      />
    </div>
  );
}
