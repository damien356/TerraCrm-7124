import * as React from "react";
import { Link } from "wouter";
import { Pencil, Plus } from "lucide-react";
import { Card, CardHeader, Empty } from "../ui/card";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Field, Input } from "../ui/field";
import { Modal } from "../ui/modal";
import { useArchiveSdsProduct, useSaveSdsProduct } from "../../queries/swms-lib";
import { ErrorLine, RUST, type Overview } from "./shared";

type Product = Overview["sds"][number];

/** The list of products a task block can point its SDS at. The sheets themselves live on the SWMS and SDS page. */
export function SdsProductsTab({ data }: { data: Overview }) {
  const [edit, setEdit] = React.useState<Product | "new" | null>(null);
  const [showArchived, setShowArchived] = React.useState(false);
  const archive = useArchiveSdsProduct();
  const missing = new Set(data.warnings.filter((w) => w.kind === "missing_sds").map((w) => w.code));
  const usedIn = (code: string) => data.blocks.filter((b) => !b.archived && b.items.some((i) => i.sds === code)).map((b) => b.title);
  const list = data.sds.filter((p) => showArchived || !p.archived);

  return (
    <Card>
      <CardHeader
        title="SDS products"
        subtitle="Products a task block can attach a safety data sheet for. Upload the sheets on the SWMS and SDS page."
        action={
          <Button size="sm" onClick={() => setEdit("new")}>
            <Plus className="size-3.5" /> New product
          </Button>
        }
      />
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input type="checkbox" aria-label="Show archived" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived
        </label>
        <Link to="/safety" className="text-xs text-primary hover:underline">
          Upload sheets
        </Link>
      </div>
      {list.length === 0 ? (
        <Empty>No products yet.</Empty>
      ) : (
        <ul className="divide-y divide-border">
          {list.map((p) => {
            const used = usedIn(p.code);
            return (
              <li key={p.code} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {p.product} {p.archived ? <Badge>Archived</Badge> : null}
                    {missing.has(p.code) ? <Badge colour={RUST}>No sheet on file</Badge> : null}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {p.supplier ? `${p.supplier} · ` : ""}
                    {used.length ? `Used in ${used.join(", ")}` : "Not used in any task block"}
                  </p>
                </div>
                {p.id !== null ? (
                  <div className="flex gap-1.5">
                    {p.archived ? (
                      <Button size="sm" variant="ghost" onClick={() => archive.mutate({ id: p.id!, archived: false })}>
                        Restore
                      </Button>
                    ) : (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => setEdit(p)}>
                          <Pencil className="size-3.5" /> Rename
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            if (used.length && !confirm(`${p.product} is used in ${used.join(", ")}. Archive it anyway? Blocks keep pointing at it.`)) return;
                            archive.mutate({ id: p.id!, archived: true });
                          }}
                        >
                          Archive
                        </Button>
                      </>
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <ErrorLine error={archive.error} />
      {edit ? <ProductEditor p={edit === "new" ? null : edit} onClose={() => setEdit(null)} /> : null}
    </Card>
  );
}

function ProductEditor({ p, onClose }: { p: Product | null; onClose: () => void }) {
  const save = useSaveSdsProduct();
  const [product, setProduct] = React.useState(p?.product ?? "");
  const [supplier, setSupplier] = React.useState(p?.supplier ?? "");
  async function go() {
    await save.mutateAsync({ id: p?.id ?? null, product, supplier });
    onClose();
  }
  return (
    <Modal open onClose={onClose} title={p ? `Rename ${p.product}` : "New SDS product"}>
      <div className="grid gap-3">
        <Field label="Product">
          <Input value={product} onChange={(e) => setProduct(e.target.value)} placeholder="Bona Traffic HD" />
        </Field>
        <Field label="Supplier">
          <Input value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder="Bona" />
        </Field>
        <ErrorLine error={save.error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={save.isPending || product.trim().length < 2} onClick={() => void go().catch(() => {})}>
            {save.isPending ? "Saving" : "Save"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
