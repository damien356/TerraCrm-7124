import * as React from "react";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * A form over a saved record that never goes stale (notes 18.66).
 *
 * - The form fills from the saved record, and any field not edited here
 *   follows the saved record as it refreshes: a slow load, a save on another
 *   tab, a skill ticked on the same card.
 * - `dirty` lists only the fields edited since the saved copy, so a save
 *   sends just those and can never put back an old value it didn't touch.
 * - `reset` takes the fresh saved copy after a save.
 */
export function useSyncedForm<F extends Record<string, unknown>>(source: F | null, recordKey: unknown) {
  const [form, setForm] = React.useState<F | null>(source);
  const [base, setBase] = React.useState<F | null>(source);
  const baseRef = React.useRef<F | null>(source);
  const keyRef = React.useRef(recordKey);
  const sig = source ? JSON.stringify(source) : null;

  React.useEffect(() => {
    if (!source) return;
    const prev = baseRef.current;
    const sameRecord = keyRef.current === recordKey && prev !== null;
    baseRef.current = source;
    keyRef.current = recordKey;
    setBase(source);
    setForm((f) => {
      if (!f || !sameRecord) return source;
      const next = { ...f };
      for (const k of Object.keys(source) as Array<keyof F>) {
        if (same(f[k], prev[k])) next[k] = source[k];
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- follows the saved record by value, not identity
  }, [sig, recordKey]);

  const reset = React.useCallback((fresh: F) => {
    baseRef.current = fresh;
    setBase(fresh);
    setForm(fresh);
  }, []);

  const dirty = form && base ? (Object.keys(form) as Array<keyof F>).filter((k) => !same(form[k], base[k])) : [];

  return { form, setForm, base, dirty, reset };
}
