import { useTranslations } from "next-intl";
import type { Consent, Use } from "@/lib/chain/consent";
import { USE_FIELDS } from "@/lib/chain/consent";

/**
 * One use, drawn as a mark rather than written as a word.
 *
 * The shapes are the fingerprint grid's own cells (components/BitGrid.tsx):
 * filled for allowed, struck for not allowed, half filled where conditions
 * apply, an open outline for a use nobody has spoken about. Drawn here as four
 * paths so they take the ink of whatever colour the card is set in, and so the
 * product owes nothing to an icon pack.
 */
export function UseMark({ state, className = "h-3.5 w-3.5" }: { state: Use; className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 12 12" className={className} fill="none">
      {state === "allowed" ? <rect x="0.5" y="0.5" width="11" height="11" fill="currentColor" /> : null}

      {state === "notAllowed" ? (
        <>
          <rect x="1" y="1" width="10" height="10" stroke="currentColor" strokeWidth="1.4" />
          <path d="M1.8 10.2 L10.2 1.8" stroke="currentColor" strokeWidth="1.4" />
        </>
      ) : null}

      {state === "constrained" ? (
        <>
          <rect x="1" y="1" width="10" height="10" stroke="currentColor" strokeWidth="1.4" />
          <path d="M1 1 L11 11 L1 11 Z" fill="currentColor" />
        </>
      ) : null}

      {state === "unspecified" ? (
        <rect x="1" y="1" width="10" height="10" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2.6 2.2" />
      ) : null}
    </svg>
  );
}

/**
 * The four uses as a two by two block, in the order the contract stores them.
 *
 * Small enough to sit inside a timeline segment and still say, without a word,
 * how many of the four were allowed. A reader who hears the page instead of
 * seeing it gets the four names and the four answers read out.
 */
export function UseBlock({
  consent,
  size = "h-3.5 w-3.5",
  className = "",
}: {
  consent: Consent;
  size?: string;
  className?: string;
}) {
  const t = useTranslations("passport.consent");
  const said = USE_FIELDS.map((field) => `${t(`uses.${field}`)}: ${t(`state.${consent[field]}`)}`).join(", ");

  return (
    <span role="img" aria-label={said} className={`inline-grid grid-cols-2 gap-[3px] ${className}`}>
      {USE_FIELDS.map((field) => (
        <UseMark key={field} state={consent[field]} className={size} />
      ))}
    </span>
  );
}
