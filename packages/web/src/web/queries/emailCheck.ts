import { useQuery } from "@tanstack/react-query";
import { orpc } from "../lib/api";

/** Format, typo and mail server check for one email. Only runs once the address looks like an email. */
export function useEmailCheck(email: string, enabled: boolean) {
  return useQuery({
    ...orpc.emailCheck.check.queryOptions({ input: { email } }),
    enabled: enabled && !!email,
    staleTime: 10 * 60_000,
    retry: false,
  });
}
