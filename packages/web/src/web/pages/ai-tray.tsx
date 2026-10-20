import * as React from "react";
import { Link } from "wouter";
import { Page } from "../components/layout";
import { Card, CardHeader, Empty, Loading } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { cn } from "@/lib/utils";
import { useAiLog, useAiTray, useResolveAiActions, type AiAgentFilter } from "../queries/ai-actions";

/**
 * WAITING FOR YOU (step 1, 20 Oct).
 *
 * One list of what the Ops helpers did and what they want a person to look
 * at. A drafted PO stays here until someone sends it, marks it sent, removes
 * it or cancels it. Nothing on this page sends anything.
 */

type TrayItem = NonNullable<ReturnType<typeof useAiTray>["data"]>["items"][number];

const AGENTS: { key: AiAgentFilter; label: string }[] = [
  { key: null, label: "All" },
  { key: "purchasing", label: "Purchasing" },
  { key: "invoices", label: "Invoices" },
  { key: "mail", label: "Mail" },
];

function when(d: Date | string | null | undefined) {
  if (!d) return "";
  const t = new Date(d);
  return t.toLocaleString("en-AU", { timeZone: "Australia/Brisbane", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

export default function AiTrayPage() {
  const [tab, setTab] = React.useState<"waiting" | "log">("waiting");
  return (
    <Page
      title="Waiting for you"
      subtitle="What the Ops helpers did, and what they want you to look at. Nothing here sends anything."
      actions={
        <div className="flex gap-1">
          <Button size="sm" variant={tab === "waiting" ? "default" : "outline"} onClick={() => setTab("waiting")}>
            Waiting
          </Button>
          <Button size="sm" variant={tab === "log" ? "default" : "outline"} onClick={() => setTab("log")}>
            Log
          </Button>
        </div>
      }
    >
      {tab === "waiting" ? <Tray /> : <Log />}
    </Page>
  );
}

function Tray() {
  const q = useAiTray();
  const items = q.data?.items ?? [];
  if (q.isLoading) return <Loading />;
  if (q.error) return <p className="text-sm text-destructive">{q.error.message}</p>;
  if (!items.length)
    return (
      <Card>
        <Empty>Nothing is waiting on you.</Empty>
      </Card>
    );
  return (
    <Card>
      <CardHeader title={`Waiting (${items.length})`} subtitle="Oldest first, so nothing sinks." />
      <div className="divide-y divide-border">
        {items.map((r) => (
          <TrayRow key={r.id} row={r} />
        ))}
      </div>
    </Card>
  );
}

function TrayRow({ row }: { row: TrayItem }) {
  const resolve = useResolveAiActions();
  const [error, setError] = React.useState<string | null>(null);
  async function act(how: "done" | "dismissed") {
    setError(null);
    try {
      await resolve.mutateAsync({ ids: [row.id], how });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  return (
    <div className="flex flex-wrap items-start gap-3 px-4 py-3">
      <div className="min-w-[240px] flex-1">
        <p className="text-xs text-muted-foreground">
          {row.agentLabel} · {row.kindLabel} · {when(row.createdAt)}
        </p>
        {row.path ? (
          <Link to={row.path} className="text-sm font-medium text-primary hover:underline">
            {row.title}
          </Link>
        ) : (
          <p className="text-sm font-medium">{row.title}</p>
        )}
        {row.detail ? <p className="mt-0.5 whitespace-pre-line text-xs text-muted-foreground">{row.detail}</p> : null}
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" disabled={resolve.isPending} onClick={() => void act("done")}>
          Done
        </Button>
        <Button size="sm" variant="ghost" disabled={resolve.isPending} onClick={() => void act("dismissed")}>
          Leave it
        </Button>
      </div>
      {error ? <p className="w-full text-xs font-medium text-destructive">{error}</p> : null}
    </div>
  );
}

const STATUS_LABEL: Record<string, string> = { waiting: "Waiting", done: "Done", dismissed: "Left" };

function Log() {
  const [agent, setAgent] = React.useState<AiAgentFilter>(null);
  const q = useAiLog(agent);
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <Card>
      <CardHeader
        title="Log"
        subtitle="Everything the helpers did, newest first."
        action={
          <div className="flex gap-1">
            {AGENTS.map((a) => (
              <button
                key={a.label}
                type="button"
                onClick={() => setAgent(a.key)}
                className={cn("rounded px-2 py-0.5 text-xs", agent === a.key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted")}
              >
                {a.label}
              </button>
            ))}
          </div>
        }
      />
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <p className="px-4 py-3 text-sm text-destructive">{q.error.message}</p>
      ) : !items.length ? (
        <Empty>Nothing logged yet.</Empty>
      ) : (
        <div className="divide-y divide-border">
          {items.map((r) => (
            <div key={r.id} className="flex flex-wrap items-start gap-3 px-4 py-2.5">
              <div className="min-w-[240px] flex-1">
                <p className="text-xs text-muted-foreground">
                  {r.agentLabel} · {r.kindLabel} · {when(r.createdAt)}
                </p>
                {r.path ? (
                  <Link to={r.path} className="text-sm text-primary hover:underline">
                    {r.title}
                  </Link>
                ) : (
                  <p className="text-sm">{r.title}</p>
                )}
                {r.detail ? <p className="mt-0.5 whitespace-pre-line text-xs text-muted-foreground">{r.detail}</p> : null}
              </div>
              <div className="text-right text-xs text-muted-foreground">
                <p className={cn(r.status === "waiting" && "font-medium text-foreground")}>{STATUS_LABEL[r.status] ?? r.status}</p>
                {r.resolvedBy ? (
                  <p>
                    {r.resolvedBy}, {when(r.resolvedAt)}
                  </p>
                ) : null}
              </div>
            </div>
          ))}
          {q.hasNextPage ? (
            <div className="px-4 py-3">
              <Button size="sm" variant="outline" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
                Show older
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </Card>
  );
}
