import * as React from "react";
import { ClipboardCheck, KeyRound } from "lucide-react";
import { Card } from "./ui/card";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { SetPasswordModal } from "./set-password-modal";
import { useReviewerLogin, useReviewerSetPassword } from "../queries/invites";

/**
 * The App Store and Google Play reviewer login (notes 18.58). Not in the People
 * list because it never touches live Terra: it signs in to a made up demo
 * copy as one crew member with one demo job, and no real client data.
 */
export function ReviewerLoginCard() {
  const reviewer = useReviewerLogin();
  const setPw = useReviewerSetPassword();
  const [open, setOpen] = React.useState(false);
  const r = reviewer.data;

  return (
    <Card className="mt-4 p-4 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="flex items-center gap-2 font-medium">
            <ClipboardCheck className="size-4 text-primary" />
            App store reviewer login
          </p>
          <p className="text-muted-foreground">
            {r?.email ?? "google-review@terraflooring.com.au"}. For Apple and Google reviewers only. It signs in as one
            demo crew member with one made up job. It never sees real clients, jobs or prices.
          </p>
          <p className="text-muted-foreground">
            After you set the password, type the same one into App Store Connect (TestFlight, Test Information) and
            Play Console (App content, App access).
          </p>
          {r ? (
            <div className="flex flex-wrap items-center gap-2 pt-1 text-xs">
              {!r.exists ? (
                <Badge className="bg-destructive/10 text-destructive">Login missing</Badge>
              ) : r.hasPassword ? (
                <Badge colour="#15803D">Has a password</Badge>
              ) : (
                <Badge colour="#B45309">No password yet</Badge>
              )}
              <span className="text-muted-foreground">
                Last signed in: {r.lastSeenAt ? new Date(r.lastSeenAt).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "never"}
              </span>
            </div>
          ) : null}
        </div>
        <Button variant="ghost" disabled={!r?.exists} onClick={() => setOpen(true)}>
          <KeyRound className="size-4" />
          Set password
        </Button>
      </div>
      <SetPasswordModal
        open={open}
        who={r?.email ?? "Reviewer login"}
        onClose={() => setOpen(false)}
        onSave={(password) => setPw.mutateAsync({ password })}
      />
    </Card>
  );
}
