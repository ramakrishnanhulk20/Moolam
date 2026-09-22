"use client";

import { YourPassports } from "@/components/studio/YourPassports";

/**
 * The one screen behind the five tabs that does not exist yet.
 *
 * Today everything an account has registered sits at the bottom of the studio,
 * below the register panel, which on a phone is a long way down a page whose
 * job is something else. The fifth tab gives it an address, and this is what
 * would be at it. The words are the bench's own: nothing goes into the message
 * files until Ram picks a drawing.
 *
 * The list under the sign in is the studio's own component, given the answer a
 * visitor with no account has: nothing, read from the index. It is drawn here
 * so the empty state and the call can be judged in one frame.
 */
export function MineFixture() {
  return (
    <div className="mx-auto w-full max-w-[1400px] px-5 py-16">
      <header className="relative">
        <p className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.28em] text-accent">
          <span className="motif h-[10px] w-[10px]" />
          You are not signed in
        </p>
        <h1 className="mt-6 max-w-[14ch] font-display text-[clamp(2.6rem,8.5vw,6.5rem)] font-semibold uppercase leading-[0.86] tracking-[-0.035em]">
          Mine
        </h1>
        <p className="mt-7 max-w-[52ch] text-base leading-relaxed text-text-muted">
          Every picture this account has registered, read live from the index. Sign in and yours are here within a
          block.
        </p>

        <button
          type="button"
          className="mt-8 rounded-[8px] bg-accent px-7 py-4 text-sm font-semibold uppercase tracking-[0.14em] text-accent-ink transition-transform duration-200 hover:-translate-y-0.5"
        >
          Sign in
        </button>
      </header>

      <YourPassports passports={{ status: "ready", passports: [], error: null, refresh: () => undefined }} />
    </div>
  );
}
