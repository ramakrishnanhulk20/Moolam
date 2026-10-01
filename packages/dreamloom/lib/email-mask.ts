/**
 * An email as Dreamloom shows it: the first letter, a fixed run of stars and the domain, so the
 * screen confirms which address it means without spelling it out. The run is fixed so the mask
 * does not give away how long the name before the @ is.
 */
export function maskEmail(email: string): string {
  const text = email.trim();
  const at = text.lastIndexOf("@");
  if (at <= 0 || at === text.length - 1) return "****";
  const first = [...text.slice(0, at)][0] ?? "";
  return `${first}****@${text.slice(at + 1)}`;
}
