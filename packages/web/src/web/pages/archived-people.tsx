import * as React from "react";
import { Archive, RotateCcw } from "lucide-react";
import { Page } from "../components/layout";
import { Card, Empty, Loading, Spinner } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { useBootstrap } from "../queries/settings";
import { useArchivedPeople, useRestorePerson } from "../queries/team";

/**
 * Everyone the main admin archived (Damien, 30 Oct). The main admin, and
 * Office or Admin people ticked "Can restore people", can bring them back.
 * Only the main admin can bring back an Admin.
 */

const KIND: Record<"admin" | "office" | "field" | "card", string> = {
  admin: "Admin",
  office: "Office",
  field: "Field crew",
  card: "Installer card, no login",
};

function day(iso: string | null) {
  if (!iso) return "-";
  return new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}

export default function ArchivedPeoplePage() {
  const list = useArchivedPeople();
  const restore = useRestorePerson();
  const bootstrap = useBootstrap();
  const mainAdmin = Boolean(bootstrap.data?.actor.isMainAdmin);
  const [note, setNote] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  type Row = NonNullable<typeof list.data>[number];

  async function bringBack(row: Row) {
    setNote(null);
    setError(null);
    const what = row.profileId
      ? `Restore ${row.name}? Their login works again and they can be booked again.`
      : `Restore ${row.name}? Their card can be booked again.`;
    if (!window.confirm(what)) return;
    try {
      const r = await restore.mutateAsync(row.profileId ? { profileId: row.profileId } : { installerId: row.installerId! });
      setNote(
        r.hasLogin
          ? `${r.name} is back. They sign in with their old password. If they have forgotten it, the main admin can send a new invite from People.`
          : `${r.name} is back and can be booked again.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Page
      title="Archived people"
      subtitle="People who have left. Their name stays on past jobs, pay and safety records. Restore brings them back exactly as they were."
    >
      {note ? <div className="mb-4 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{note}</div> : null}
      {error ? (
        <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>
      ) : null}

      {list.isPending ? (
        <Loading label="Loading archived people…" />
      ) : list.isError ? (
        <Card className="p-4 text-sm text-destructive">{list.error.message}</Card>
      ) : !list.data?.length ? (
        <Card>
          <Empty>
            <Archive className="mx-auto mb-2 size-5" />
            No one is archived.
          </Empty>
        </Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="th px-4">Person</th>
                <th className="th px-4">Was</th>
                <th className="th px-4">Archived</th>
                <th className="th px-4" aria-label="Restore" />
              </tr>
            </thead>
            <tbody>
              {list.data.map((row) => {
                const adminRow = row.role === "admin";
                const blocked = adminRow && !mainAdmin;
                return (
                  <tr key={row.key} className="border-b border-border/40 align-top last:border-0">
                    <td className="px-4 py-3">
                      <div className="font-medium">{row.name}</div>
                      <div className="text-xs text-muted-foreground">{[row.mobile, row.email].filter(Boolean).join(" · ") || "No mobile or email"}</div>
                    </td>
                    <td className="px-4 py-3">
                      <Badge>{KIND[row.role]}</Badge>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {day(row.archivedAt)}
                      {row.archivedByName ? <div className="text-xs">by {row.archivedByName}</div> : null}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {blocked ? (
                        <span className="text-xs text-muted-foreground">Only the main admin can bring back an Admin.</span>
                      ) : (
                        <Button variant="outline" size="sm" disabled={restore.isPending} onClick={() => bringBack(row)}>
                          {restore.isPending && restore.variables && ("profileId" in restore.variables ? restore.variables.profileId === row.profileId : restore.variables.installerId === row.installerId) ? (
                            <Spinner className="border-foreground/20 border-t-foreground" />
                          ) : (
                            <RotateCcw className="size-3.5" />
                          )}
                          Restore
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
    </Page>
  );
}
