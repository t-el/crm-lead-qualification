/** Normalise phone numbers to E.164 so the same person texting, calling and filling a form is one lead. */
export function toE164(raw: string | null | undefined, defaultCallingCode = "1"): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  let digits = trimmed.replace(/[^\d]/g, "");
  if (!digits) return null;
  if (trimmed.startsWith("+")) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.startsWith("00")) digits = digits.slice(2);
  else if (defaultCallingCode === "1" && digits.length === 10) digits = `1${digits}`;
  else if (defaultCallingCode === "1" && digits.length === 11 && digits.startsWith("1")) { /* already has 1 */ }
  else if (digits.startsWith("0")) digits = defaultCallingCode + digits.slice(1);
  else if (digits.length <= 10) digits = defaultCallingCode + digits;
  return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
}

export const maskPhone = (p: string | null) => (p ? `${p.slice(0, 4)}***${p.slice(-2)}` : null);
