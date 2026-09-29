"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { SECONDARY_BUTTON } from "./Headline";

/**
 * Try again for the first screen's evidence when neither the registry nor the
 * index answered.
 *
 * The board's reads are made on the server, so trying again means asking for
 * the page again. It is a plain reload rather than the router's refresh: the
 * first screen is the top of the page, so nothing a reader was looking at is
 * lost, and the board then renders under any parent, not only inside the app
 * router. The button says it is asking until the new page arrives.
 */
export function ReadAgain({ reload = () => window.location.reload() }: { reload?: () => void }) {
  const common = useTranslations("common");
  const retry = useTranslations("retry");
  const [asking, setAsking] = useState(false);

  return (
    <button
      type="button"
      data-first-read-again
      onClick={() => {
        setAsking(true);
        reload();
      }}
      disabled={asking}
      aria-busy={asking}
      className={`gap-2 ${SECONDARY_BUTTON}`}
    >
      {asking ? <span aria-hidden className="h-1.5 w-1.5 animate-pulse bg-accent" /> : null}
      {asking ? retry("trying") : common("tryAgain")}
    </button>
  );
}
