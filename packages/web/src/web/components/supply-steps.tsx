import { Check, ChevronDown } from "lucide-react";
import { Card, CardHeader } from "./ui/card";
import { Button } from "./ui/button";
import { moneyExact } from "../lib/money";
import { useDeliveryStatus } from "../queries/delivery";
import {
  useClientInvoices,
  useJobBilling,
  useMaterialSelection,
} from "../queries/clientInvoices";
import { usePurchasingForJob } from "../queries/purchasing";

/**
 * SUPPLY JOB STEPS (188001 fix list item 14).
 *
 * A supply only job is run from its job page: colours, PO, delivery, invoice,
 * payment. This card shows where the job is up to and jumps to the card that
 * does each step. Nothing here changes data, the cards below do that.
 */

export const STEP_ANCHOR = {
  colours: "job-step-colours",
  order: "job-step-order",
  delivered: "job-step-delivered",
  invoice: "job-step-invoice",
} as const;

const dayOf = (v: Date | string | null | undefined) => {
  if (!v) return null;
  const d = typeof v === "string" ? new Date(v) : v;
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
};

function jump(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "start" });
  el.classList.add("ring-2", "ring-primary", "rounded-lg");
  window.setTimeout(
    () => el.classList.remove("ring-2", "ring-primary", "rounded-lg"),
    1600,
  );
}

const NEXT: Record<string, string> = {
  order: "raise and send the PO",
  delivered: "mark it delivered with the proof",
  invoice: "send the invoice",
  paid: "record the payment",
};

interface Step {
  key: string;
  title: string;
  state: string;
  done: boolean;
  optional?: boolean;
  go?: { label: string; anchor: string };
}

export function SupplyStepsCard({
  jobId,
  isAdmin,
}: {
  jobId: number;
  isAdmin: boolean;
}) {
  const status = useDeliveryStatus(jobId);
  const sel = useMaterialSelection(jobId);
  const inv = useClientInvoices(jobId);
  const billing = useJobBilling(jobId);
  const po = usePurchasingForJob(isAdmin ? jobId : null);

  const st = status.data;
  if (!st?.supplyOnly) return null;

  const s = sel.data;
  const colours: Step = s?.submittedAt
    ? {
        key: "colours",
        title: "Colours checked",
        state: `Checked${s.submittedName ? ` by ${s.submittedName}` : ""}, ${dayOf(s.submittedAt)}.`,
        done: true,
        optional: true,
      }
    : s?.sentAt
      ? {
          key: "colours",
          title: "Colours checked",
          state: `Form sent ${dayOf(s.sentAt)}. Waiting on the client.`,
          done: false,
          optional: true,
          go: { label: "Material selection", anchor: STEP_ANCHOR.colours },
        }
      : {
          key: "colours",
          title: "Colours checked",
          state:
            "Form not sent. Skip it when the quote already names the colour.",
          done: false,
          optional: true,
          go: { label: "Send form", anchor: STEP_ANCHOR.colours },
        };

  let order: Step;
  if (!isAdmin) {
    order = {
      key: "order",
      title: "Ordered",
      state: "An admin raises and sends the PO.",
      done: false,
    };
  } else {
    const live = (po.data?.pos ?? []).filter((p) => p.status !== "cancelled");
    const sent = live.filter((p) => p.sentAt);
    const drafts = live.filter((p) => !p.sentAt);
    const notOnPo = (po.data?.materials ?? []).filter(
      (m) => !m.onPo && m.status === "to_order",
    );
    const refs = (list: typeof live) => list.map((p) => p.number).join(", ");
    if (!po.data)
      order = {
        key: "order",
        title: "Ordered",
        state: "Loading.",
        done: false,
      };
    else if (sent.length && !drafts.length && !notOnPo.length)
      order = {
        key: "order",
        title: "Ordered",
        state: `${refs(sent)} sent${sent.length === 1 && sent[0]?.sentAt ? ` ${dayOf(sent[0].sentAt)}` : ""}.`,
        done: true,
      };
    else if (drafts.length)
      order = {
        key: "order",
        title: "Ordered",
        state: `${refs(drafts)} is a draft, not sent yet.`,
        done: false,
        go: { label: "Purchase orders", anchor: STEP_ANCHOR.order },
      };
    else if (notOnPo.length)
      order = {
        key: "order",
        title: "Ordered",
        state: `${notOnPo.length} material${notOnPo.length === 1 ? "" : "s"} not on a PO yet.`,
        done: false,
        go: { label: "Raise PO", anchor: STEP_ANCHOR.order },
      };
    else
      order = {
        key: "order",
        title: "Ordered",
        state: "Nothing to order.",
        done: true,
      };
  }

  const delivered: Step = st.completedAt
    ? {
        key: "delivered",
        title: "Delivered",
        state: `Delivered ${dayOf(st.completedAt)}${st.deliveredBy ? `, marked by ${st.deliveredBy}` : ""}.`,
        done: true,
      }
    : {
        key: "delivered",
        title: "Delivered",
        state: "Not marked yet. Add the proof when it arrives.",
        done: false,
        go: { label: "Mark delivered", anchor: STEP_ANCHOR.delivered },
      };

  const b = billing.data;
  const i = inv.data;
  const unsent = (i?.invoices ?? []).filter((r) => r.status !== "paid" && r.status !== "void" && r.outstanding > 0 && !r.emailedAt);
  let invoice: Step;
  if (!b || !i) invoice = { key: "invoice", title: "Invoiced", state: "Loading.", done: false };
  else if (unsent.length)
    invoice = {
      key: "invoice",
      title: "Invoiced",
      state: `${unsent.map((r) => r.ref).join(", ")} raised, not emailed yet.`,
      done: false,
      go: { label: "Email invoice", anchor: STEP_ANCHOR.invoice },
    };
  else if (b.toBill <= 0.004 && i.billed > 0) invoice = { key: "invoice", title: "Invoiced", state: `Billed in full, ${moneyExact(i.billed)}.`, done: true };
  else
    invoice = {
      key: "invoice",
      title: "Invoiced",
      state: `${moneyExact(b.toBill)} still to bill${i.billed > 0 ? `, ${moneyExact(i.billed)} billed so far` : ""}.${st.completedAt ? "" : " Mark delivered raises the final for you."}`,
      done: false,
      go: { label: "Client invoices", anchor: STEP_ANCHOR.invoice },
    };

  const paid: Step =
    invoice.done && i && i.owing <= 0.004
      ? {
          key: "paid",
          title: "Paid",
          state: `Paid in full, ${moneyExact(i.received)}.`,
          done: true,
        }
      : {
          key: "paid",
          title: "Paid",
          state:
            i && i.owing > 0
              ? `${moneyExact(i.owing)} owing.`
              : "Nothing billed yet.",
          done: false,
          go:
            i && i.owing > 0
              ? { label: "Record payment", anchor: STEP_ANCHOR.invoice }
              : undefined,
        };

  const steps = [colours, order, delivered, invoice, paid];
  // The next step is the first one still open that can be done from here.
  const next = steps.find((x) => !x.done && !x.optional && x.go) ?? null;

  return (
    <Card>
      <CardHeader
        title="Supply job steps"
        subtitle={
          next
            ? `Next: ${NEXT[next.key] ?? next.title.toLowerCase()}. Everything is done from the cards on this page.`
            : steps.every((x) => x.done || x.optional)
              ? "All done. Every step on this job is complete."
              : !isAdmin && !order.done
                ? "Waiting on an admin to send the PO."
                : "Loading."
        }
      />
      <ol className="divide-y divide-border">
        {steps.map((x, n) => (
          <li
            key={x.key}
            className="flex items-center gap-3 px-4 py-2.5 text-sm"
          >
            <span
              className={
                x.done
                  ? "flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground"
                  : "flex size-6 shrink-0 items-center justify-center rounded-full border border-border text-xs text-muted-foreground"
              }
            >
              {x.done ? <Check className="size-3.5" /> : n + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                {x.title}
                {x.optional ? (
                  <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                    optional
                  </span>
                ) : null}
              </p>
              <p className="text-xs text-muted-foreground">{x.state}</p>
            </div>
            {x.go ? (
              <Button
                size="sm"
                variant={next?.key === x.key ? "secondary" : "outline"}
                onClick={() => jump(x.go!.anchor)}
              >
                {x.go.label}
                <ChevronDown className="size-3.5" />
              </Button>
            ) : null}
          </li>
        ))}
      </ol>
    </Card>
  );
}
