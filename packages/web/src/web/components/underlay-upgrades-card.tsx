import * as React from "react";
import { ArrowRight, Plus, Trash2 } from "lucide-react";
import { Card, CardHeader, Empty, Loading } from "./ui/card";
import { Button } from "./ui/button";
import { Field, Select } from "./ui/field";
import { moneyExact } from "../lib/money";
import { errorText } from "./public-shell";
import { useSaveUnderlayUpgrades, useUnderlayUpgrades } from "../queries/underlayUpgrades";

/**
 * Settings, Business rules (fix list item 9): which underlay upgrades to
 * which. When the accepted quote has the first one, the material selection
 * form offers the second at the Price list sell difference, inc GST.
 */

const CATEGORY_LABEL: Record<string, string> = {
  carpet_underlay: "Carpet underlay",
  hard_floor_underlay: "Hard floor underlay",
  underlay: "Underlay",
};

const unitText = (u: string) => (u === "m2" ? "m²" : u);

export function UnderlayUpgradesCard() {
  const q = useUnderlayUpgrades();
  const save = useSaveUnderlayUpgrades();
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  const pairs = q.data?.pairs ?? [];
  const underlays = q.data?.underlays ?? [];
  const groups = Object.entries(
    underlays.reduce<Record<string, typeof underlays>>((acc, u) => {
      (acc[u.category] ??= []).push(u);
      return acc;
    }, {}),
  );
  const fromProduct = underlays.find((u) => String(u.id) === from);

  function options(exclude?: number) {
    return groups.map(([cat, list]) => (
      <optgroup key={cat} label={CATEGORY_LABEL[cat] ?? cat}>
        {list
          .filter((u) => u.id !== exclude)
          .map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}, {u.supplier}
              {u.sellPrice != null ? `, ${moneyExact(u.sellPrice)}/${unitText(u.unit)}` : ""}
            </option>
          ))}
      </optgroup>
    ));
  }

  async function write(next: { from: number; to: number }[]) {
    setError(null);
    try {
      await save.mutateAsync({ pairs: next });
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    }
  }

  async function add() {
    if (!from || !to) return setError("Pick both underlays.");
    const next = [...pairs.filter((p) => String(p.from) !== from).map((p) => ({ from: p.from, to: p.to })), { from: Number(from), to: Number(to) }];
    if (await write(next)) {
      setFrom("");
      setTo("");
    }
  }

  return (
    <Card>
      <CardHeader
        title="Underlay upgrades"
        subtitle="When the accepted quote has the first underlay, the material selection form offers the second for the extra. Priced off the Price list sell prices, inc GST."
      />
      <div className="space-y-4 px-4 py-4">
        {q.isLoading ? (
          <Loading />
        ) : pairs.length ? (
          <ul className="divide-y divide-border rounded-md border border-border">
            {pairs.map((p) => (
              <li key={p.from} className="flex items-start gap-2 px-3 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-1.5 font-medium">
                    {p.fromName}
                    <ArrowRight className="size-3.5 text-muted-foreground" />
                    {p.toName}
                  </p>
                  <p className={`text-xs ${p.check.ok ? "text-muted-foreground" : "text-destructive"}`}>
                    {p.check.ok ? `${moneyExact(p.check.perUnitIncGst)} inc GST more per ${unitText(p.check.unit)}` : `Not offered. ${p.check.reason}`}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${p.fromName} upgrade`}
                  disabled={save.isPending}
                  onClick={() => write(pairs.filter((x) => x.from !== p.from).map((x) => ({ from: x.from, to: x.to })))}
                >
                  <Trash2 className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>No upgrades yet. Add one below, e.g. Standard to Premium.</Empty>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Quoted underlay">
            <Select aria-label="Quoted underlay" value={from} onChange={(e) => setFrom(e.target.value)}>
              <option value="">Pick one</option>
              {options()}
            </Select>
          </Field>
          <Field label="Upgrade to">
            <Select aria-label="Upgrade to" value={to} onChange={(e) => setTo(e.target.value)}>
              <option value="">Pick one</option>
              {options(fromProduct?.id)}
            </Select>
          </Field>
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <div className="flex justify-end">
          <Button variant="outline" onClick={add} disabled={save.isPending || !from || !to}>
            <Plus className="size-4" />
            {pairs.some((p) => String(p.from) === from) ? "Replace upgrade" : "Add upgrade"}
          </Button>
        </div>
      </div>
    </Card>
  );
}
