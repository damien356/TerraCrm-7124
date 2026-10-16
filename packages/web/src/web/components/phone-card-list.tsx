import * as React from "react";
import { Link } from "wouter";
import { ChevronRight } from "lucide-react";

/**
 * Lists as stacked cards inside the phone app (Damien, 16 Oct). The website
 * on a computer keeps its tables; a page swaps to this only when isPhoneApp.
 * Each card is one finger sized tap that opens the record.
 */
export type PhoneCard = {
  key: string | number;
  /** Where a tap goes. Left off, the card does not open anything. */
  href?: string;
  /** The job or quote number, or the name for a client. */
  title: React.ReactNode;
  /** Status badges, shown on the right of the title. */
  badges?: React.ReactNode;
  /** Usually the customer. */
  line1?: React.ReactNode;
  /** Usually the site. */
  line2?: React.ReactNode;
  /** Anything small underneath: a date, a value, a count. */
  meta?: React.ReactNode;
};

export function PhoneCardList({ items }: { items: PhoneCard[] }) {
  return (
    <ul className="divide-y divide-border">
      {items.map((item) => {
        const body = (
          <>
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-2">
                <p className="min-w-0 truncate text-[15px] font-semibold text-foreground">{item.title}</p>
                {item.badges ? <div className="flex shrink-0 flex-wrap justify-end gap-1">{item.badges}</div> : null}
              </div>
              {item.line1 ? <p className="mt-0.5 truncate text-sm">{item.line1}</p> : null}
              {item.line2 ? <p className="mt-0.5 truncate text-xs text-muted-foreground">{item.line2}</p> : null}
              {item.meta ? <div className="mt-1 text-xs text-muted-foreground">{item.meta}</div> : null}
            </div>
            {item.href ? <ChevronRight className="mt-0.5 size-4 shrink-0 self-center text-muted-foreground" /> : null}
          </>
        );
        return (
          <li key={item.key}>
            {item.href ? (
              <Link
                to={item.href}
                className="flex min-h-[64px] items-start gap-2 px-4 py-3 transition-colors active:bg-secondary/70"
              >
                {body}
              </Link>
            ) : (
              <div className="flex min-h-[64px] items-start gap-2 px-4 py-3">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
