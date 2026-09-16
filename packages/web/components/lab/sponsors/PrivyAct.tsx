import { shortHex } from "@/lib/chain/client";
import { ENTRY_POINT, isRead, type Reading, type SponsoredRegistration } from "@/lib/lab/sponsors";
import { Act, Field, Footnote, Missing, addressLink, count, gwei, mon, txLink } from "./parts";

/**
 * Privy on the identity strip.
 *
 * The strip today shows an address, which is the one thing about the account
 * that says nothing. What is worth saying is that the creator signed with their
 * own device and paid nothing, and both of those are on chain: a passkey bound
 * to the wallet, and a registration that went through the ERC-4337 entry point.
 */
export function PrivyAct({ reading }: { reading: Reading<SponsoredRegistration> }) {
  return (
    <Act
      index="02"
      sponsor="Privy"
      heading="An address tells a creator nothing they wanted to know."
      standfirst="The newest registration whose transaction went through the ERC-4337 entry point, found by reading the transactions behind the registry's own events. A lab page has no Privy session, so this is the chain's account of one rather than the visitor's own."
      quiet={isRead(reading) ? <QuietStrip sponsored={reading.read} /> : <Missing why={reading.failed} />}
      visible={isRead(reading) ? <VisibleStrip sponsored={reading.read} /> : <Missing why={reading.failed} />}
    />
  );
}

/** The strip as it reads now: a truncated address and a word. */
function QuietStrip({ sponsored }: { sponsored: SponsoredRegistration }) {
  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex items-center gap-2 rounded-[8px] border border-line px-3 py-1.5 font-mono text-xs uppercase tracking-[0.18em] text-text-muted">
          <span aria-hidden className="motif h-[7px] w-[7px]" />
          Wallet
        </span>
        <span className="font-mono text-sm">{shortHex(sponsored.creator, 6, 4)}</span>
      </div>
      <p className="mt-6 max-w-[38ch] text-sm leading-relaxed text-text-faint">
        Everything the creator did for free, and everything they signed with their own device, is behind that address
        and said nowhere on the screen.
      </p>
    </div>
  );
}

/** The same account, with the two facts a creator actually cares about. */
function VisibleStrip({ sponsored }: { sponsored: SponsoredRegistration }) {
  return (
    <div>
      <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-text-faint">This registration</p>
      <p className="mt-4 max-w-[17ch] font-display text-[clamp(2.2rem,6vw,4.4rem)] font-semibold uppercase leading-[0.88] tracking-[-0.045em]">
        Fee paid by Moolam through Privy
      </p>

      <div className="mt-8 flex flex-wrap items-end gap-x-10 gap-y-4 border-t border-line pt-6">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">It would have cost you</p>
          <p className="mt-2 font-display text-[clamp(1.8rem,4vw,3rem)] font-semibold leading-[0.95] tracking-[-0.04em] tabular-nums">
            {mon(sponsored.feeMon)}
            <span className="ms-2 font-mono text-sm tracking-[0.08em] text-accent">MON</span>
          </p>
        </div>
        <p className="font-mono text-xs leading-relaxed text-text-faint tabular-nums">
          {count(sponsored.gasUsed)} gas at {gwei(sponsored.gasPrice)} gwei
          <br />
          {sponsored.feeMon} MON, charged to the paymaster
        </p>
      </div>

      <p
        className={`mt-8 flex items-center gap-3 border-t border-line pt-6 font-mono text-[11px] uppercase tracking-[0.2em] ${
          sponsored.passkey ? "text-verified" : "text-text-faint"
        }`}
      >
        <span aria-hidden className={`h-2 w-2 ${sponsored.passkey ? "bg-verified" : "bg-line"}`} />
        {sponsored.passkey ? "Signed with this device's own key, no seed phrase" : "No passkey bound to this wallet yet"}
      </p>

      <dl className="mt-7 grid gap-x-8 gap-y-6 sm:grid-cols-2">
        <Field label="Transaction" value={shortHex(sponsored.txHash, 10, 8)} href={txLink(sponsored.txHash)} />
        <Field label="Block" value={count(sponsored.block)} />
        <Field label="Sent by the bundler" value={shortHex(sponsored.sender)} href={addressLink(sponsored.sender)} />
        <Field label="Entry point" value={shortHex(ENTRY_POINT)} href={addressLink(ENTRY_POINT)} />
        <Field label="Creator" value={shortHex(sponsored.creator)} href={addressLink(sponsored.creator)} />
        <Field
          label="Found"
          value={sponsored.scanned === 1 ? "the newest registration" : `${count(sponsored.scanned)} registrations back`}
        />
      </dl>

      <Footnote>
        The fee is the receipt&apos;s own gas and price, which is what the creator would have paid had they sent it
        themselves. Monad bills the gas limit rather than the gas burned, so it is the full billed figure. The passkey
        line is read from the registry: the creator&apos;s wallet has a public key bound to it, and that key signs every
        registration.
      </Footnote>
    </div>
  );
}
