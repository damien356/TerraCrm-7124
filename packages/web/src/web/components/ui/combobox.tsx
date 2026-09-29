import * as React from "react";
import { Check, ChevronDown, X } from "lucide-react";
import { cn } from "@/lib/utils";

export type ComboboxOption = {
  value: string;
  label: string;
  sublabel?: string;
};

/**
 * Searchable dropdown. Type to filter — unlike a native <select>, which only
 * jumps to the next option starting with the last key pressed. Use this for
 * any list long enough that a person would rather type than scroll
 * (companies, contacts, products…).
 */
export function Combobox({
  value,
  onChange,
  options,
  placeholder = "Search…",
  emptyLabel = "None",
  disabled,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  options: ComboboxOption[];
  placeholder?: string;
  emptyLabel?: string;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [highlight, setHighlight] = React.useState(0);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const selected = options.find((o) => o.value === value) ?? null;

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) =>
        o.label.toLowerCase().includes(q) ||
        (o.sublabel ?? "").toLowerCase().includes(q),
    );
  }, [options, query]);

  React.useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  React.useEffect(() => {
    if (open) setHighlight(0);
  }, [open, query]);

  function pick(v: string) {
    onChange(v);
    setOpen(false);
    setQuery("");
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) setOpen(true);
      setHighlight((h) => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const opt = filtered[highlight];
      if (opt) pick(opt.value);
    } else if (e.key === "Escape") {
      setOpen(false);
      setQuery("");
    }
  }

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <div
        className={cn(
          "flex h-9 w-full items-center gap-1 rounded-md border border-border bg-card px-3 text-sm transition-colors focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/15",
          disabled && "opacity-50",
        )}
      >
        <input
          ref={inputRef}
          disabled={disabled}
          aria-label={selected ? selected.label : placeholder}
          className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground/70"
          placeholder={selected ? selected.label : placeholder}
          value={open ? query : ""}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
        />
        {!open && selected ? (
          <span className="pointer-events-none absolute left-3 right-8 truncate text-sm text-foreground">
            {selected.label}
          </span>
        ) : null}
        {selected && !disabled ? (
          <button
            type="button"
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation();
              pick("");
            }}
            className="rounded p-0.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        ) : (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        )}
      </div>
      {open ? (
        <div className="absolute z-50 mt-1 max-h-64 w-full overflow-auto rounded-md border border-border bg-card shadow-lg">
          <button
            type="button"
            onClick={() => pick("")}
            className={cn(
              "flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-muted-foreground hover:bg-secondary",
              value === "" && "bg-secondary/60",
            )}
          >
            {emptyLabel}
          </button>
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-sm text-muted-foreground">No matches</div>
          ) : (
            filtered.map((o, i) => (
              <button
                key={o.value}
                type="button"
                onClick={() => pick(o.value)}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-secondary",
                  i === highlight && "bg-secondary",
                  o.value === value && "font-medium",
                )}
              >
                {o.value === value ? (
                  <Check className="size-3.5 shrink-0 text-primary" />
                ) : (
                  <span className="size-3.5 shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate">
                  {o.label}
                  {o.sublabel ? (
                    <span className="ml-1.5 text-xs text-muted-foreground">{o.sublabel}</span>
                  ) : null}
                </span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
