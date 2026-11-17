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
  upgradeTemplate,
  type QuoteEmailValues,
} from "../../api/lib/quote-email-template";

/** What each {placeholder} turns into, for the list on the card. Damien, 17 Nov 2026: most now come from the quote's lines. */
const FIELD_HELP: { key: keyof QuoteEmailValues; meaning: string }[] = [
  { key: "first_name", meaning: "The client's first name" },
  { key: "quote_number", meaning: "The quote number, e.g. 188000. The send adds it to the end of the subject anyway" },
  { key: "quote_title", meaning: "What the quote is for, short, e.g. timber floor repair" },
  { key: "suburb", meaning: "The job's suburb. Left out when there is none" },
  { key: "opening", meaning: "The thank you and what the quote is for, from the quote's lines" },
  { key: "scope", meaning: "What the quote is for, e.g. the timber floor repairs" },
  { key: "review_line", meaning: "The line before the link, e.g. You can review the repair work included…" },
  { key: "link", meaning: "The link to view and accept online" },
  { key: "total", meaning: "The quote total incl. GST" },
  { key: "deposit", meaning: "The deposit in dollars, or that it is paid. Left out when there is none" },
  { key: "valid_until", meaning: "The valid until date. Left out when there is none" },
  { key: "next_steps", meaning: "What happens once they accept, from the quote's lines and deposit" },
];

const SAMPLE: QuoteEmailValues = {
  first_name: "Steven",
  quote_number: "188000",
  quote_title: "timber floor repair",
  suburb: "Highgate Hill",
  opening: "Thank you for sending through the photos. Please find your quote for the timber floor repairs at your Highgate Hill property.",
  scope: "the timber floor repairs",
  review_line: "You can review the repair work included and accept your quote using the link below:",
  link: "https://ops.terraflooring.com.au/q/…",
  total: "$2,917.20",
  deposit: "$1,458.60",
  valid_until: "17 December 2026",
  next_steps: "Once you have accepted the quote and paid the deposit, we'll contact you to arrange a suitable time for the repairs.",
};

/** Settings, Business tab: the wording the Email quote dialog opens with (fix list item 11). */
export function QuoteEmailCard({ settings }: { settings: Record<string, string> }) {
  const save = useSetSetting();
  /* A copy saved before 17 Nov 2026 is shown as the email will use it. */
  const saved = upgradeTemplate({
    subject: settings[QUOTE_EMAIL_SUBJECT_KEY]?.trim() || DEFAULT_QUOTE_EMAIL_SUBJECT,
    body: settings[QUOTE_EMAIL_BODY_KEY]?.trim() || DEFAULT_QUOTE_EMAIL_BODY,
  });
  const savedSubject = saved.subject.trim();
  const savedBody = saved.body.trim();
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
              A part of a line split with " · " or " — " is left out when its placeholder has nothing to show. The sample is a repair quote; the real wording follows each quote's lines.
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
