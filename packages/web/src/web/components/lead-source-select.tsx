import { Select } from "./ui/field";
import { useLeadSources } from "../queries/leads";

/**
 * Where the job came from, off the list in Settings, Leads (notes 18.38).
 * Stores the source name itself, e.g. "Google Ads: Pharmacy" or "Phone".
 */
export function LeadSourceSelect({
  id,
  value,
  onChange,
  invalid,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  invalid?: boolean;
}) {
  const q = useLeadSources();
  const names = (q.data ?? []).map((s) => s.name);
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={invalid}>
      <option value="" disabled>
        {q.isLoading ? "Loading…" : "Pick one…"}
      </option>
      {value && !names.includes(value) ? <option value={value}>{value}</option> : null}
      {names.map((n) => (
        <option key={n} value={n}>
          {n}
        </option>
      ))}
    </Select>
  );
}
