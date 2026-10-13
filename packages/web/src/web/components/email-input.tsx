import * as React from "react";
import { cn } from "@/lib/utils";
import { Input } from "./ui/field";
import { useEmailCheck } from "../queries/emailCheck";
import { emailFormatOk, suggestEmail } from "../../api/lib/email-typo";

/**
 * Email field that checks itself, like ServiceM8.
 *
 * Red when the address is not an email (after leaving the field) or its domain
 * can't take mail. "Did you mean bob@gmail.com?" shows for common typos and a
 * tap fixes the field. Never blocks saving.
 */

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

type Props = Omit<React.ComponentProps<"input">, "value" | "onChange" | "type" | "inputMode"> & {
  value: string;
  onValueChange: (value: string) => void;
  wrapperClassName?: string;
};

export function EmailInput({ value, onValueChange, className, wrapperClassName, onBlur, ...rest }: Props) {
  const typed = value.trim();
  const settled = useDebounced(typed, 600);
  // An address already on file is checked straight away; a new one once they leave the field.
  const [left, setLeft] = React.useState(() => typed.length > 0);
  const stable = settled === typed;
  const formatOk = emailFormatOk(settled);
  const check = useEmailCheck(settled, stable && formatOk);
  const result = check.data && check.data.email === settled ? check.data : null;

  const badFormat = stable && !!settled && !formatOk && left;
  const noMail = stable && result?.status === "no_mail";
  const red = !!typed && (badFormat || noMail);
  const suggestion = typed && stable ? suggestEmail(settled) : null;

  return (
    <div className={wrapperClassName}>
      <Input
        {...rest}
        // Plain text, not type="email": the browser must never stop a save over the format.
        type="text"
        inputMode="email"
        autoCapitalize="none"
        spellCheck={false}
        value={value}
        aria-invalid={red || undefined}
        onChange={(e) => onValueChange(e.target.value)}
        onBlur={(e) => {
          setLeft(true);
          onBlur?.(e);
        }}
        className={cn(red && "border-destructive bg-destructive/5 focus:border-destructive focus:ring-destructive/15", className)}
      />
      {red ? (
        <p className="mt-1 text-xs text-destructive">{badFormat ? "This is not a valid email address." : result?.message}</p>
      ) : null}
      {suggestion ? (
        <button
          type="button"
          onClick={() => onValueChange(suggestion)}
          className="mt-1 block text-left text-xs text-amber-800 hover:underline"
        >
          Did you mean <span className="font-semibold">{suggestion}</span>?
        </button>
      ) : null}
    </div>
  );
}
