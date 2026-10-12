import * as React from "react";
import { ImagePlus, Trash2 } from "lucide-react";
import { Button } from "./ui/button";
import { Loading, Spinner } from "./ui/card";
import { Modal } from "./ui/modal";
import { errorText } from "./public-shell";
import { useProduct, useSetSwatch } from "../queries/products";

/**
 * Item 8 (fix list 13 Oct). The colour swatch picture the client sees on the
 * material selection form. Without one the form shows the colour name.
 */
export function SwatchEditor({ id, swatchUrl, colour }: { id: number; swatchUrl: string | null; colour: string }) {
  const set = useSetSwatch();
  const input = React.useRef<HTMLInputElement>(null);
  const [error, setError] = React.useState<string | null>(null);

  function run(file: File | null) {
    setError(null);
    set.mutate({ id, file }, { onError: (e) => setError(errorText(e)) });
  }

  return (
    <div className="flex items-start gap-3">
      {swatchUrl ? (
        <img src={swatchUrl} alt={colour} className="size-20 shrink-0 rounded-lg border border-border object-cover" />
      ) : (
        <div className="flex size-20 shrink-0 items-center justify-center rounded-lg border border-dashed border-border bg-secondary p-1 text-center text-[11px] text-muted-foreground">
          No swatch
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted-foreground">
          Shown to the client on the material selection form. With no picture the form shows the colour name, {colour || "blank"}.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <input
            ref={input}
            type="file"
            accept="image/*"
            className="hidden"
            aria-label="Swatch picture"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              e.target.value = "";
              if (f) run(f);
            }}
          />
          <Button size="sm" variant="outline" disabled={set.isPending} onClick={() => input.current?.click()}>
            {set.isPending ? <Spinner /> : <ImagePlus className="size-3.5" />}
            {swatchUrl ? "Replace swatch" : "Upload swatch"}
          </Button>
          {swatchUrl ? (
            <Button size="sm" variant="ghost" disabled={set.isPending} onClick={() => run(null)}>
              <Trash2 className="size-3.5" />
              Remove
            </Button>
          ) : null}
        </div>
        {error ? <p className="mt-1 text-xs text-destructive">{error}</p> : null}
      </div>
    </div>
  );
}

/** The Price list row's Swatch button opens this. */
export function SwatchModal({ id, title, onClose }: { id: number; title: string; onClose: () => void }) {
  const product = useProduct(id);
  const p = product.data;
  return (
    <Modal open onClose={onClose} title={`Swatch, ${title}`}>
      {!p ? <Loading /> : <SwatchEditor id={p.id} swatchUrl={p.swatchUrl} colour={p.colour} />}
    </Modal>
  );
}
