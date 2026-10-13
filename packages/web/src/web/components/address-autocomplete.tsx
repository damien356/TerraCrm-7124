import * as React from "react";
import { MapPin } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "./ui/field";
import { Spinner } from "./ui/card";
import { usePlaceDetails, usePlaceSuggestions, usePlacesEnabled } from "../queries/places";

/**
 * Street address box with Google suggestions (Places API, New).
 *
 * Typing offers Australian addresses near Brisbane; a pick hands back the
 * street, suburb, state, postcode and map pin. With no Google key it is a
 * plain box. Anything not in Google's list can still be typed and saved.
 */

export interface PickedAddress {
  address: string;
  suburb: string;
  state: string;
  postcode: string;
  formatted: string;
  lat: number | null;
  lng: number | null;
  placeId: string;
}

const newToken = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

function useDebounced<T>(value: T, ms = 250) {
  const [out, setOut] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setOut(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return out;
}

/** One line for a billing address box: "14 Smith St, Paddington QLD 4064". */
export function billingLine(a: PickedAddress) {
  return (
    a.formatted.replace(/,\s*Australia$/, "").trim() ||
    [a.address, [a.suburb, a.state, a.postcode].filter(Boolean).join(" ")].filter(Boolean).join(", ")
  );
}

/** Whether Google suggestions are on (the key is set). */
export function usePlacesOn() {
  return !!usePlacesEnabled().data?.enabled;
}

export function AddressAutocomplete({
  id,
  value,
  onType,
  onPick,
  placeholder,
  className,
  icon = false,
}: {
  id?: string;
  value: string;
  /** Typed by hand. */
  onType: (value: string) => void;
  /** Picked from Google's list. */
  onPick: (address: PickedAddress) => void;
  placeholder?: string;
  className?: string;
  /** Map pin icon inside the box. */
  icon?: boolean;
}) {
  const on = usePlacesOn();
  const [session, setSession] = React.useState(newToken);
  const [open, setOpen] = React.useState(false);
  const [picked, setPicked] = React.useState(false);
  const typed = useDebounced(value);
  const suggestions = usePlaceSuggestions(typed, session, on && open && !picked);
  const details = usePlaceDetails();
  const [lookupError, setLookupError] = React.useState<string | null>(null);
  const listId = `${id ?? "addr"}_suggestions`;

  async function pick(placeId: string) {
    setLookupError(null);
    setOpen(false);
    try {
      const a = await details.mutateAsync({ placeId, sessionToken: session });
      setPicked(true);
      onPick(a);
    } catch (e) {
      setLookupError(e instanceof Error ? e.message : String(e));
    } finally {
      // A pick ends Google's billing session. The next search starts a new one.
      setSession(newToken());
    }
  }

  const list = on && open && !picked ? (suggestions.data ?? []) : [];

  return (
    <div className="relative">
      <div className="relative">
        {icon ? <MapPin className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /> : null}
        <Input
          id={id}
          className={cn(icon && "pl-8", className)}
          value={value}
          onChange={(e) => {
            setPicked(false);
            setOpen(true);
            onType(e.target.value);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder={placeholder}
          autoComplete="off"
          aria-describedby={list.length ? listId : undefined}
        />
        {details.isPending ? <Spinner className="absolute right-2.5 top-1/2 -translate-y-1/2" /> : null}
      </div>
      {list.length ? (
        <ul
          id={listId}
          aria-label="Address suggestions"
          className="absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-md border border-border bg-card shadow-lg"
        >
          {list.map((s) => (
            <li key={s.placeId}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(s.placeId)}
                className="block w-full px-3 py-2 text-left text-sm hover:bg-secondary"
              >
                <span className="font-medium">{s.main}</span>
                {s.secondary ? <span className="text-muted-foreground"> {s.secondary}</span> : null}
              </button>
            </li>
          ))}
          <li className="px-3 py-1 text-right text-[10px] text-muted-foreground">Powered by Google</li>
        </ul>
      ) : null}
      {lookupError ? <p className="mt-1 text-xs text-destructive">{lookupError}</p> : null}
    </div>
  );
}
