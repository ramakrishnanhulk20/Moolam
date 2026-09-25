import { getTranslations } from "next-intl/server";
import { OPENING_LINE, ToolOpening } from "./ToolOpening";

/**
 * Where the opening's line sits, set on the page's frame because the thing it
 * answers to is further down the page: while the sign-in card (or its dimmed
 * waiting copy) is there, the line stands beside the title; once a signed in
 * creator's studio is there, the line moves under the title on a laptop and
 * the right-hand place goes to the slot the studio's path switch is drawn in.
 */
export const OPENING_SEATS =
  "lg:[&:not(:has([data-signed-out]))_[data-opening-line=beside]]:hidden lg:[&:not(:has([data-signed-out]))_[data-opening-line=under]]:block lg:[&:not(:has([data-signed-out]))_[data-studio-switch-slot]]:block";

/**
 * The words at the top of the studio, drawn on the server: the compact opening
 * every tool page has, so the studio itself is in the first screen.
 *
 * They used to be motion components inside the wallet screen, so the served
 * HTML carried them at opacity 0 and a phone waited 11.5 s for script before
 * the lede could paint. Here they are plain markup with the CSS rise, in the
 * first byte, in every language, and the reduced-motion rule in globals.css
 * turns the rise off.
 */
export async function StudioIntro({ locale }: { locale: string }) {
  const t = await getTranslations({ locale, namespace: "studio" });
  const line = t("lede");

  // The line is drawn in both seats and OPENING_SEATS shows one, so the
  // server's HTML is right for a visitor before anyone knows who they are.
  return (
    <ToolOpening
      kicker={t("kicker")}
      title={t("title")}
      locale={locale}
      under={
        <p data-opening-line="under" className={`${OPENING_LINE} mt-4 hidden`} style={{ animationDelay: "120ms" }}>
          {line}
        </p>
      }
      aside={
        <>
          <p data-opening-line="beside" className={`${OPENING_LINE} lg:justify-self-end`} style={{ animationDelay: "120ms" }}>
            {line}
          </p>
          {/* Empty in the server's HTML. The signed in studio draws its path
              switch into it, so the switch is a cell of this grid and meets the
              foot of the title block by the grid's own alignment. */}
          <div data-studio-switch-slot className="hidden min-w-0" />
        </>
      }
    />
  );
}
