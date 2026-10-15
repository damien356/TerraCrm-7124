/**
 * Notes 18.44. The Terra phone app shows the office pages inside itself, and
 * every API call from there carries this header. Quote prices are read only
 * on the phone, so the procedures that set a price check it as well as the
 * screen. The same login on the website is not affected.
 */
export const PHONE_APP_HEADER = "x-terra-app";

export function fromPhoneApp(headers: Headers | undefined | null): boolean {
  return headers?.get(PHONE_APP_HEADER) === "phone";
}

export const PHONE_PRICE_MESSAGE = "Prices are changed on the website, not in the phone app.";
