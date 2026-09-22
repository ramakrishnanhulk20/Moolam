import Image from "next/image";
import { LocaleSwitch } from "@/components/LocaleSwitch";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Link } from "@/lib/i18n/routing";

/**
 * The bar over a phone screen once the tabs are at the bottom: the wordmark,
 * the language and the theme. Nothing else.
 *
 * The menu button it replaces existed to hold seven links a row could not fit.
 * The tab bar holds five of them in sight all the time, so the button has
 * nothing left to open and the top of the screen goes back to the page.
 *
 * The row is 55 px and its rule one more, which is the 56 px --header-h in
 * globals.css says a phone header is. The film pulls itself up by exactly that
 * number, so the two must stay equal.
 */
export function PhoneHeader({ brand, className = "" }: { brand: string; className?: string }) {
  return (
    <header
      className={`sticky top-0 z-40 border-b border-line bg-bg/85 backdrop-blur-md ${className}`}
    >
      <div className="flex h-[55px] w-full items-center gap-4 px-5">
        {/* The lockup files carry clear space on every side, so the box is 63 px
            tall for 24 px of cap height and the negative margin keeps the row
            the height the ink asks for. The theme class picks the variant, and
            a story page forces the dark one because that bar floats on a dark
            film; under the light theme the two rules in globals.css that watch
            data-lockup hand the light one back. */}
        <Link href="/" className="-my-[18px] flex items-center transition-opacity duration-200 hover:opacity-70">
          <Image
            src="/brand/seal-o/lockup-horizontal-dark.svg"
            alt={brand}
            width={160}
            height={63}
            unoptimized
            loading="eager"
            fetchPriority="high"
            data-lockup="dark"
            className="hidden dark:block [body:has([data-story])_&]:block"
          />
          <Image
            src="/brand/seal-o/lockup-horizontal-light.svg"
            alt={brand}
            width={160}
            height={63}
            unoptimized
            loading="eager"
            data-lockup="light"
            className="block dark:hidden [body:has([data-story])_&]:hidden"
          />
        </Link>

        {/* Both chips are drawn small on purpose and grown to a 44 px target by
            the tap-row rule in globals.css. */}
        <div className="tap-row ms-auto flex items-center gap-2">
          <LocaleSwitch />
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
