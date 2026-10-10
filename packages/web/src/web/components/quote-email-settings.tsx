import * as React from "react";
import { Card, CardHeader, Spinner } from "./ui/card";
import { Button } from "./ui/button";
import { Field, Input, Textarea } from "./ui/field";
import { useSetSetting } from "../queries/settings";
import {
  DEFAULT_QUOTE_EMAIL_BODY,
  DEFAULT_QUOTE_EMAIL_SUBJECT,
  fillQuoteTemplate,
  QUOTE_EMAIL_BODY_KEY,
  QUOTE_EMAIL_SUBJECT_KEY,
  SCOPE_FILL,
  type QuoteEmailValues,
} from "../../api/lib/quote-email-template";

/** What each {placeholder} turns into, for the list on the card. */
const FIELD_HELP: { key: keyof QuoteEmailValues; meaning: string }[] = [
  { key: "first_name", meaning: "The client's first name" },
  { key: "quote_number", meaning: "The quote number, e.g. 188000" },
  { key: "scope", meaning: `Left as ${SCOPE_FILL} for you to type in each time` },
  { key: "link", meaning: "The link to view and accept online" },
  { key: "total", meaning: "The quote total incl. GST" },
  { key: "deposit", meaning: "The deposit in dollars. Left out when there is none" },
  { key: "valid_until", meaning: "The valid until date. Left out when there is none" },
];

const SAMPLE: QuoteEmailValues = {
  first_name: "Natalia",
  quote_number: "188000",
  scope: "carpet to 3 bedrooms and lounge",
  link: "https://ops.terraflooring.com.au/q/…",
  total: "$5,003.14",
  deposit: "$1,500.94",
  valid_until: "9 November 2026",
};

/** Settings, Business tab: the wording the Email quote dialog opens with (fix list item 11). */
export function QuoteEmailCard({ settings }: { settings: Record<string, string> }) {
  const save = useSetSetting();
  const savedSubject = settings[QUOTE_EMAIL_SUBJECT_KEY]?.trim() || DEFAULT_QUOTE_EMAIL_SUBJECT;
  const savedBody = settings[QUOTE_EMAIL_BODY_KEY]?.trim() || DEFAULT_QUOTE_EMAIL_BODY;
  const [subject, setSubject] = React.useState(savedSubject);
  const [body, setBody] = React.useState(savedBody);
  const [note, setNote] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => setSubject(savedSubject), [savedSubject]);
  React.useEffect(() => setBody(savedBody), [savedBody]);

  const changed = subject.trim() !== savedSubject || body.trim() !== savedBody;
  const isDefault = subject.trim() === DEFAULT_QUOTE_EMAIL_SUBJECT && body.trim() === DEFAULT_QUOTE_EMAIL_BODY;

  async function write(nextSubject: string, nextBody: string, done: string) {
    setError(null);
    try {
      // Saved empty when it matches the default, so a later change to the default reaches it.
      await save.mutateAsync({ key: QUOTE_EMAIL_SUBJECT_KEY, value: nextSubject.trim() === DEFAULT_QUOTE_EMAIL_SUBJECT ? "" : nextSubject.trim() });
      await save.mutateAsync({ key: QUOTE_EMAIL_BODY_KEY, value: nextBody.trim() === DEFAULT_QUOTE_EMAIL_BODY ? "" : nextBody.trim() });
      setNote(done);
      window.setTimeout(() => setNote(null), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Card className="lg:col-span-2">
      <CardHeader
        title="Quote email"
        subtitle="What the Email quote dialog opens with. You can still change it on each email before it goes."
      />
      <div className="grid gap-4 px-4 py-4 lg:grid-cols-[1fr_18rem]">
        <div className="flex flex-col gap-3">
          <Field label="Subject">
            <Input aria-label="Quote email subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
          </Field>
          <Field label="Message">
            <Textarea
              aria-label="Quote email message"
              rows={16}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              className="font-[inherit] text-[13px] leading-relaxed"
            />
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => write(subject, body, "Saved")} disabled={!changed || save.isPending || !subject.trim() || !body.trim()}>
              {save.isPending ? <Spinner /> : null}
              Save wording
            </Button>
            <Button
              variant="outline"
              disabled={isDefault || save.isPending}
              onClick={() => {
                setSubject(DEFAULT_QUOTE_EMAIL_SUBJECT);
                setBody(DEFAULT_QUOTE_EMAIL_BODY);
                void write(DEFAULT_QUOTE_EMAIL_SUBJECT, DEFAULT_QUOTE_EMAIL_BODY, "Back to the default wording");
              }}
            >
              Reset to default
            </Button>
            {note ? <span className="text-xs text-[var(--success)]">{note}</span> : null}
            {changed && !note ? <span className="text-xs text-muted-foreground">Not saved yet</span> : null}
          </div>
          {error ? <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
        </div>
        <div className="flex flex-col gap-3 text-sm">
          <div>
            <p className="mb-1.5 font-medium">Placeholders</p>
            <ul className="space-y-1.5">
              {FIELD_HELP.map((f) => (
                <li key={f.key} className="text-xs text-muted-foreground">
                  <code className="rounded bg-secondary px-1 py-0.5 text-[11px] text-foreground">{`{${f.key}}`}</code> {f.meaning}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-muted-foreground">
              A part of a line split with " · " is left out when its placeholder has nothing to show.
            </p>
          </div>
          <div>
            <p className="mb-1.5 font-medium">Preview</p>
            <div className="rounded-md border border-border bg-secondary/40 px-3 py-2 text-xs leading-relaxed">
              <p className="mb-2 font-medium">{fillQuoteTemplate(subject, SAMPLE).replace(/\s*\n\s*/g, " ")}</p>
              <p className="whitespace-pre-wrap">{fillQuoteTemplate(body, SAMPLE)}</p>
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}
