import * as React from "react";
import { AlertTriangle, HardHat, Mail, MessageSquare, Pin, PinOff, Send, Smartphone, StickyNote } from "lucide-react";
import { Card, CardHeader, Empty, Loading, Spinner } from "./ui/card";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Field, Input, Select, Textarea } from "./ui/field";
import {
  useJobConversation,
  useMarkRead,
  usePinMessage,
  useRecipients,
  useSenders,
  useSendMessage,
  useSmsCost,
  useUnpinMessage,
} from "../queries/conversations";
import { EmailInput } from "./email-input";
import { CcList, EmailAttachments, NO_ATTACHMENTS, type MailAttachments } from "./email-attachments";
import { MoveToJobButton } from "./mail-filing";

/**
 * THE JOB CONVERSATION.
 *
 * One thread per job, read top to bottom as one story, sent down separate
 * channels. The composer makes the audience the first choice you make, because
 * that is the choice that decides who sees it: an internal note has no send
 * path at all, so it cannot reach a customer by accident.
 *
 * Nothing here claims more than we know. An email says "sent" because that is
 * all Gmail tells us, and no outgoing message is ever shown as read.
 *
 * Every email about the job shows here, in and out, newest at the bottom:
 * quotes, variations, invoices and colour forms included. A repair's or a
 * variation's email carries its label. Any email can be moved to another job.
 */

/* What you can be doing. Each one is an audience plus a channel. */
const MODES = [
  { id: "note", label: "Internal note", audience: "internal", channel: "note", icon: StickyNote },
  { id: "customer-sms", label: "Text customer", audience: "customer", channel: "sms", icon: Smartphone },
  { id: "customer-email", label: "Email customer", audience: "customer", channel: "email", icon: Mail },
  { id: "installer-sms", label: "Text crew", audience: "installer", channel: "sms", icon: HardHat },
] as const;

type ModeId = (typeof MODES)[number]["id"];

const CHANNEL_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  sms: Smartphone,
  email: Mail,
  note: StickyNote,
  app: MessageSquare,
};

const AUDIENCE_COLOUR: Record<string, string | undefined> = {
  customer: "#3E6B4F",
  installer: "#2F5D8C",
  supplier: "#7A5C9E",
  internal: undefined,
};

const when = (value: string | Date) =>
  new Date(value).toLocaleString("en-AU", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });

/* ------------------------------------------------------------------ *
 * One message in the thread.
 * ------------------------------------------------------------------ */

function Message({
  m,
  onPin,
  onUnpin,
  busy,
  jobId,
}: {
  m: {
    id: number;
    channel: string;
    audience: string;
    direction: string;
    subject: string | null;
    body: string;
    authorName: string | null;
    fromAddress: string | null;
    toAddress: string | null;
    ccAddress?: string | null;
    mailbox?: string | null;
    label?: string | null;
    autoReply?: boolean | null;
    status: string | null;
    statusDetail: string | null;
    pinnedAt: string | Date | null;
    pinnedLabel: string | null;
    createdAt: string | Date;
    mentions: string[];
    attachments: { id: number; filename: string; url: string | null }[];
  };
  onPin: (id: number) => void;
  onUnpin: (id: number) => void;
  busy: boolean;
  jobId: number;
}) {
  const Icon = CHANNEL_ICON[m.channel] ?? MessageSquare;
  const inbound = m.direction === "in";
  const note = m.channel === "note";
  const failed = m.status === "failed";

  return (
    <li className="px-4 py-3">
      <div className="flex items-start gap-3">
        <span
          className={[
            "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full",
            note ? "bg-secondary text-muted-foreground" : inbound ? "bg-[var(--primary)]/10 text-[var(--primary)]" : "bg-secondary text-foreground",
          ].join(" ")}
        >
          <Icon className="size-3.5" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium">{m.authorName || (inbound ? "Them" : "Office")}</span>
            <Badge colour={AUDIENCE_COLOUR[m.audience]}>{note ? "internal" : m.audience}</Badge>
            <Badge>{inbound ? "received" : m.channel}</Badge>
            {m.label ? <Badge colour="#8A6D3B">{m.label}</Badge> : null}
            {m.autoReply ? <Badge>automatic reply</Badge> : null}
            {failed ? (
              <Badge colour="#B4472E">
                <AlertTriangle className="size-3" /> {m.channel === "sms" ? "text failed" : m.channel === "email" ? "email failed" : "failed"}
              </Badge>
            ) : !inbound && (m.channel === "email" || m.channel === "sms") && m.status === "sent" ? (
              <span title={m.channel === "sms" ? "ClickSend accepted the text. That does not prove it reached the phone." : "The mail server accepted it. That does not prove it reached the inbox."}>
                <Badge colour="#4A7A52">sent</Badge>
              </span>
            ) : null}
            {m.pinnedAt ? (
              <Badge colour="#BC9558">
                <Pin className="size-3" /> {m.pinnedLabel || "pinned"}
              </Badge>
            ) : null}
            <span className="ml-auto flex items-center gap-1">
              <span className="text-[11px] text-muted-foreground">{when(m.createdAt)}</span>
              {m.channel === "email" ? <MoveToJobButton messageId={m.id} currentJobId={jobId} /> : null}
              <Button
                variant="ghost"
                size="icon-sm"
                title={m.pinnedAt ? "Unpin" : "Pin to important information"}
                disabled={busy}
                onClick={() => (m.pinnedAt ? onUnpin(m.id) : onPin(m.id))}
              >
                {m.pinnedAt ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
              </Button>
            </span>
          </div>

          {m.subject ? <p className="mt-1 text-sm font-medium">{m.subject}</p> : null}
          <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed">{m.body}</p>

          {m.attachments.length ? (
            <ul className="mt-1.5 flex flex-wrap gap-2">
              {m.attachments.map((a) => (
                <li key={a.id}>
                  <a
                    href={a.url ?? "#"}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-primary hover:underline"
                  >
                    {a.filename}
                  </a>
                </li>
              ))}
            </ul>
          ) : null}

          <p className="mt-1 text-[11px] text-muted-foreground">
            {inbound
              ? m.fromAddress
                ? `from ${m.fromAddress}`
                : null
              : m.toAddress
                ? `to ${m.toAddress}${m.mailbox || m.fromAddress ? ` from ${(m.mailbox || m.fromAddress)!.split("@")[0]}@` : ""}`
                : null}
            {m.ccAddress ? ` · cc ${m.ccAddress}` : null}
            {failed && m.statusDetail ? ` · ${m.statusDetail}` : null}
            {m.mentions.length ? ` · ${m.mentions.map((n) => `@${n.split(" ")[0]}`).join(" ")}` : null}
          </p>
        </div>
      </div>
    </li>
  );
}

/* ------------------------------------------------------------------ *
 * The composer. Audience first, because it decides everything after.
 * ------------------------------------------------------------------ */

function Composer({ jobId, conversationId }: { jobId: number; conversationId: number }) {
  const recipients = useRecipients(jobId);
  const send = useSendMessage();

  const [mode, setMode] = React.useState<ModeId>("note");
  const [to, setTo] = React.useState("");
  const [subject, setSubject] = React.useState("");
  const [body, setBody] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  /* Email only: the address typed or picked, copies, which mailbox, files. */
  const [toEmail, setToEmail] = React.useState("");
  const [cc, setCc] = React.useState<string[]>([]);
  const [mailbox, setMailbox] = React.useState("");
  const [files, setFiles] = React.useState<MailAttachments>(NO_ATTACHMENTS);

  const picked = MODES.find((m) => m.id === mode)!;
  const isEmail = picked.channel === "email";
  const cost = useSmsCost(body, picked.channel === "sms");
  const senders = useSenders();

  const customers = recipients.data?.customers ?? [];
  const crew = recipients.data?.crew ?? [];
  const emailable = customers.filter((c) => c.email);

  /* Who this mode can actually reach, with the reason when it cannot. */
  const options =
    picked.id === "customer-sms"
      ? customers.filter((c) => c.receivesSms).map((c) => ({ value: `contact:${c.contactId}`, label: `${c.name} · ${c.mobile}` }))
      : picked.id === "installer-sms"
        ? crew.map((i) => ({ value: `installer:${i.installerId}`, label: `${i.name} · ${i.mobile ?? "no mobile"}` }))
        : [];

  const needsRecipient = picked.id !== "note";

  React.useEffect(() => {
    setError(null);
    setNotice(null);
    setTo(options.length === 1 ? options[0]!.value : "");
    if (isEmail && !toEmail) {
      const first = customers.filter((c) => c.receivesEmail);
      if (first.length === 1) setToEmail(first[0]!.email ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, recipients.dataUpdatedAt]);

  const toContact = emailable.find((c) => (c.email ?? "").trim().toLowerCase() === toEmail.trim().toLowerCase());
  const senderList = senders.data ?? [];
  const sender = senderList.find((x) => x.address === mailbox) ?? senderList[0];

  async function submit() {
    setError(null);
    setNotice(null);
    const text = body.trim();
    if (!text) return;
    if (isEmail && !toEmail.trim()) {
      setError("Type or pick who this goes to.");
      return;
    }
    if (!isEmail && needsRecipient && !to) {
      setError("Pick who this goes to.");
      return;
    }
    const [kind, idRaw] = to.split(":");
    const id = idRaw ? Number(idRaw) : null;

    try {
      const result = await send.mutateAsync(
        isEmail
          ? {
              conversationId,
              jobId,
              audience: "customer",
              channel: "email",
              body: text,
              subject: subject.trim() || undefined,
              to: toEmail.trim(),
              cc: cc.map((c) => c.trim()).filter(Boolean),
              mailbox: sender?.address,
              contactId: toContact?.contactId ?? null,
              mediaIds: files.mediaIds,
              uploads: files.uploads,
            }
          : {
              conversationId,
              audience: picked.audience,
              channel: picked.channel,
              body: text,
              contactId: kind === "contact" ? id : null,
              installerId: kind === "installer" ? id : null,
            },
      );
      if (!result.ok) {
        setError(result.reason ?? "That didn't go out. It's logged as failed on the thread.");
        return;
      }
      const linked = "linked" in result && Array.isArray(result.linked) ? result.linked : [];
      if (linked.length) setNotice(`Sent. ${linked.length} file${linked.length === 1 ? " was" : "s were"} too big to attach, so ${linked.length === 1 ? "it went" : "they went"} as a 7 day download link.`);
      setBody("");
      setSubject("");
      setCc([]);
      setFiles(NO_ATTACHMENTS);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't send.");
    }
  }

  return (
    <div className="border-t border-border bg-secondary/30 px-4 py-3">
      <div className="flex flex-wrap gap-1.5">
        {MODES.map((m) => {
          const Icon = m.icon;
          const active = m.id === mode;
          return (
            <Button
              key={m.id}
              size="sm"
              variant={active ? "default" : "outline"}
              onClick={() => setMode(m.id)}
            >
              <Icon className="size-3.5" />
              {m.label}
            </Button>
          );
        })}
      </div>

      {isEmail ? (
        <div className="mt-2.5 grid gap-2">
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="To">
              <EmailInput value={toEmail} onValueChange={setToEmail} placeholder="name@example.com" />
              {emailable.length ? (
                <div className="mt-1 flex flex-wrap gap-1">
                  {emailable.map((c) => (
                    <button
                      key={c.contactId}
                      type="button"
                      onClick={() => setToEmail(c.email ?? "")}
                      className={[
                        "rounded-full border px-2 py-0.5 text-[11px]",
                        toContact?.contactId === c.contactId ? "border-foreground bg-foreground text-background" : "border-border bg-card hover:bg-secondary",
                      ].join(" ")}
                      title={c.email ?? ""}
                    >
                      {c.name || c.email}
                    </button>
                  ))}
                </div>
              ) : null}
            </Field>
            <Field label="From">
              <Select value={sender?.address ?? ""} onChange={(e) => setMailbox(e.target.value)} disabled={senderList.length < 2}>
                {senderList.map((x) => (
                  <option key={x.address} value={x.address} disabled={!x.ready}>
                    {x.name} ({x.address}){x.ready ? "" : ", needs signing in again in Settings"}
                  </option>
                ))}
              </Select>
              {senderList.find((x) => !x.ready || x.note)?.note ? (
                <p className="mt-1 text-[11px] text-muted-foreground">{senderList.find((x) => x.note)?.note}</p>
              ) : null}
            </Field>
          </div>
          <Field label="CC">
            <CcList
              value={cc}
              onChange={setCc}
              suggestions={emailable.filter((c) => c.contactId !== toContact?.contactId).map((c) => ({ email: c.email ?? "", name: c.name }))}
            />
          </Field>
          <Field label="Subject" hint="The job number goes on the end for you, so replies come back here.">
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Your floors" />
          </Field>
        </div>
      ) : needsRecipient ? (
        <div className="mt-2.5 grid gap-2 sm:grid-cols-2">
          <Field label="To">
            <Select value={to} onChange={(e) => setTo(e.target.value)}>
              <option value="">
                {options.length ? "Pick someone…" : "Nobody on this job can be reached this way"}
              </option>
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      ) : null}

      <Textarea
        className="mt-2.5"
        rows={isEmail ? 6 : 3}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={
          picked.id === "note"
            ? "Note for the office. @name to flag someone."
            : picked.id === "installer-sms"
              ? "Text the crew…"
              : "Write to the customer…"
        }
      />

      {isEmail ? (
        <div className="mt-2">
          <EmailAttachments jobId={jobId} value={files} onChange={setFiles} note="Files from the device are saved to the job file when it sends." />
        </div>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {picked.id === "note" ? (
            "Stays inside Terra. Never sent."
          ) : picked.channel === "sms" ? (
            <>
              {cost.data ? `${cost.data.parts} SMS part${cost.data.parts === 1 ? "" : "s"}` : "-"}
              {picked.audience === "customer" ? " · opt-out line added" : " · no opt-out, this is crew"}
            </>
          ) : (
            "Nothing goes until you press Send. Replies land back on this thread."
          )}
        </p>
        <Button disabled={!body.trim() || send.isPending} onClick={submit}>
          {send.isPending ? <Spinner /> : <Send className="size-4" />}
          {picked.id === "note" ? "Save note" : "Send"}
        </Button>
      </div>

      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
      {notice ? <p className="mt-2 text-xs text-[#3E6B4F]">{notice}</p> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The tab itself.
 * ------------------------------------------------------------------ */

export function JobConversation({ jobId }: { jobId: number }) {
  const thread = useJobConversation(jobId);
  const pin = usePinMessage();
  const unpin = useUnpinMessage();
  const markRead = useMarkRead();

  const conversationId = thread.data?.conversation.id ?? null;
  const count = thread.data?.messages.length ?? 0;

  /* Newest is at the bottom, so open there and follow new ones in. */
  const listRef = React.useRef<HTMLUListElement>(null);
  React.useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [count, conversationId]);

  React.useEffect(() => {
    if (conversationId) markRead.mutate({ conversationId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  if (thread.isLoading) return <Loading label="Opening the thread…" />;
  if (thread.error || !thread.data) {
    return (
      <Card>
        <Empty>Couldn't open the conversation on this job.</Empty>
      </Card>
    );
  }

  const { conversation, messages, pinned, participants } = thread.data;
  const busy = pin.isPending || unpin.isPending;

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <Card className="overflow-hidden">
        <CardHeader
          title="Conversation"
          subtitle={`${conversation.ref} · every message and email on this job, in and out, newest at the bottom.`}
        />
        {messages.length === 0 ? (
          <Empty>Nothing on this thread yet. Write the first message below.</Empty>
        ) : (
          <ul ref={listRef} className="max-h-[560px] divide-y divide-border overflow-y-auto">
            {messages.map((m) => (
              <Message
                key={m.id}
                m={m as never}
                jobId={jobId}
                busy={busy}
                onPin={(id) => pin.mutate({ messageId: id })}
                onUnpin={(id) => unpin.mutate({ messageId: id })}
              />
            ))}
          </ul>
        )}
        {conversationId ? <Composer jobId={jobId} conversationId={conversationId} /> : null}
      </Card>

      <div className="grid gap-4">
        <Card>
          <CardHeader
            title="Important job information"
            subtitle="Pinned out of the thread. Access codes, colours, what was agreed."
          />
          {pinned.length === 0 ? (
            <Empty>Nothing pinned. Use the pin on any message.</Empty>
          ) : (
            <ul className="divide-y divide-border">
              {pinned.map((m) => (
                <li key={m.id} className="px-4 py-2.5">
                  {m.pinnedLabel ? <p className="label-xs">{m.pinnedLabel}</p> : null}
                  <p className="mt-0.5 whitespace-pre-wrap text-sm">{m.body}</p>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    pinned by {m.pinnedByName || "the office"} · {m.pinnedAt ? when(m.pinnedAt) : ""}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title="On this thread" subtitle="Everyone who has been written to here." />
          {participants.length === 0 ? (
            <Empty>Nobody yet.</Empty>
          ) : (
            <ul className="divide-y divide-border">
              {participants.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-2 px-4 py-2">
                  <span className="min-w-0">
                    <span className="block truncate text-sm">{p.name || p.email || p.mobile || "Unnamed"}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {p.email || p.mobile || ""}
                    </span>
                  </span>
                  <Badge colour={AUDIENCE_COLOUR[p.role === "staff" ? "internal" : p.role]}>{p.role}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
