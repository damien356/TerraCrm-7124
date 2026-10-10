import * as React from "react";
import { Combobox } from "./ui/combobox";
import { useContactSearch } from "../queries/contacts";

/** Waits for a pause in typing before asking the server. */
function useDebounced(value: string, ms = 200) {
  const [out, setOut] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setOut(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return out;
}

/**
 * Pick a client from everyone in Ops. Searches the server as you type (name,
 * mobile, email or suburb), so a client is found however far down the
 * alphabet they sit. The old pickers loaded the first 200 by surname only.
 */
export function ContactPicker({
  value,
  onChange,
  placeholder = "Search name, mobile or email…",
  emptyLabel = "Select a person…",
  disabled,
  className,
  onPicked,
  selectedLabel,
}: {
  value: string;
  /** Name for a value set from outside (an "Already in Ops" pick). */
  selectedLabel?: string;
  onChange: (value: string) => void;
  /** The picked person's name, for lists that show who was picked before saving. */
  onPicked?: (label: string) => void;
  placeholder?: string;
  emptyLabel?: string;
  disabled?: boolean;
  className?: string;
}) {
  const [query, setQuery] = React.useState("");
  const debounced = useDebounced(query);
  const found = useContactSearch(debounced);
  // The picked name is kept here: once the search box clears, the picked
  // client is no longer among the results.
  const [pickedLabel, setPickedLabel] = React.useState("");

  const options = (debounced.trim() ? (found.data ?? []) : []).map((c) => ({
    value: String(c.id),
    label: `${c.firstName} ${c.lastName}`.trim(),
    sublabel: [c.companyNames, c.suburb || c.address, c.mobile].filter(Boolean).join(" · ") || undefined,
  }));

  return (
    <Combobox
      value={value}
      onChange={(v) => {
        const label = options.find((o) => o.value === v)?.label ?? "";
        setPickedLabel(label);
        onPicked?.(label);
        onChange(v);
      }}
      options={options}
      onQueryChange={setQuery}
      selectedLabel={selectedLabel || pickedLabel}
      loading={found.isFetching || query !== debounced}
      idleHint="Type a name, mobile or email"
      placeholder={placeholder}
      emptyLabel={emptyLabel}
      disabled={disabled}
      className={className}
    />
  );
}
