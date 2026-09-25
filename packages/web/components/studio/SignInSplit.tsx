import type { ReactNode } from "react";

/**
 * The sign-in card on the left and a real passport on the right, as the thing
 * signing in gets you. The card's column is the studio box's own width and the
 * passport takes what is left.
 *
 * Who is signed in is only known in the browser, after the page is drawn. So
 * the passport and the second column are kept for as long as the sign-in card
 * (or its dimmed waiting copy) is on the page, and a signed in creator gets
 * the full width back the moment the card goes.
 */
export function SignInSplit({ children, showcase }: { children: ReactNode; showcase: ReactNode }) {
  return (
    <div
      data-sign-in-split
      className="mt-7 grid items-start gap-10 sm:mt-8 xl:gap-14 lg:[&:has([data-signed-out])]:grid-cols-[minmax(0,44rem)_minmax(0,1fr)] [&:not(:has([data-signed-out]))>[data-showcase-slot]]:hidden"
    >
      <div className="min-w-0">{children}</div>
      <div data-showcase-slot className="min-w-0">
        {showcase}
      </div>
    </div>
  );
}
