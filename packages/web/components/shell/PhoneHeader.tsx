import Image from "next/image";
import { LocaleSwitch } from "@/components/LocaleSwitch";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Link } from "@/lib/i18n/routing";

/**
 * The bar over a phone screen once the tabs are at the bottom: the wordmark,
 * the language and the theme. Nothing else.
 *
 * The menu button it replaces existed to hold six links a row could not fit.
 * The tab bar holds five of them in sight all the time, so the button has
 * nothing left to open and the top of the screen goes back to the page.
 */
export function PhoneHeader({ brand }: { brand: string }) {
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-bg/85 backdrop-blur-md">
      <div className="flex h-[55px] w-full items-center gap-4 px-5">
        {/* The lockup files carry clear space on every side, so the box is 63 px
            tall for 24 px of cap height and the negative margin keeps the row
            the height the ink asks for. */}
        <Link href="/" className="-my-[18px] flex items-center transition-opacity duration-200 hover:opacity-70">
          <Image
            src="/brand/seal-o/lockup-horizontal-dark.svg"
            alt={brand}
            width={160}
            height={63}
            unoptimized
            loading="eager"
            fetchPriority="high"
            className="hidden dark:block"
          />
          <Image
            src="/brand/seal-o/lockup-horizontal-light.svg"
            alt={brand}
            width={160}
            height={63}
            unoptimized
            loading="eager"
            className="block dark:hidden"
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
