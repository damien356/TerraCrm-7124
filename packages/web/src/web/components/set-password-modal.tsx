import * as React from "react";
import { Eye, EyeOff } from "lucide-react";
import { Modal } from "./ui/modal";
import { Button } from "./ui/button";
import { Field, Input } from "./ui/field";
import { Spinner } from "./ui/card";

const MIN = 8;

/**
 * Type a new password for a login (notes 18.58). Asked twice so a typo can't
 * lock anyone out. Terra never shows it again after Save.
 */
export function SetPasswordModal({
  open,
  who,
  note,
  onClose,
  onSave,
}: {
  open: boolean;
  who: string;
  note?: React.ReactNode;
  onClose: () => void;
  onSave: (password: string) => Promise<unknown>;
}) {
  const [pw, setPw] = React.useState("");
  const [again, setAgain] = React.useState("");
  const [show, setShow] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState(false);

  function close() {
    setPw("");
    setAgain("");
    setShow(false);
    setError(null);
    setDone(false);
    onClose();
  }

  const problem =
    pw.length > 0 && pw.length < MIN ? `Use at least ${MIN} characters.` : again.length > 0 && again !== pw ? "The two don't match." : null;
  const ready = pw.length >= MIN && pw === again;

  async function save() {
    setError(null);
    setSaving(true);
    try {
      await onSave(pw);
      setDone(true);
      setPw("");
      setAgain("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title="Set password"
      subtitle={who}
      footer={
        done ? (
          <Button onClick={close}>Done</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button onClick={save} disabled={!ready || saving}>
              {saving ? <Spinner className="border-white/40 border-t-white" /> : null}
              Save password
            </Button>
          </>
        )
      }
    >
      {done ? (
        <p className="text-sm">Password saved. It replaces any password they had. Phones already signed in stay signed in.</p>
      ) : (
        <div className="grid gap-3">
          {note ? <div className="text-sm text-muted-foreground">{note}</div> : null}
          <Field label="New password" hint={`At least ${MIN} characters.`}>
            <div className="flex gap-2">
              <Input
                type={show ? "text" : "password"}
                autoComplete="new-password"
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                aria-label="New password"
              />
              <Button variant="ghost" type="button" onClick={() => setShow((v) => !v)} aria-label={show ? "Hide password" : "Show password"}>
                {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </Button>
            </div>
          </Field>
          <Field label="Type it again">
            <Input
              type={show ? "text" : "password"}
              autoComplete="new-password"
              value={again}
              onChange={(e) => setAgain(e.target.value)}
              aria-label="Type the password again"
            />
          </Field>
          {problem ? <p className="text-sm text-muted-foreground">{problem}</p> : null}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
      )}
    </Modal>
  );
}
