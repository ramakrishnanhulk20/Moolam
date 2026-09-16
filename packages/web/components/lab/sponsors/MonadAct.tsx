import { shortHex } from "@/lib/chain/client";
import { BLOCK_TIME_SPAN, isRead, type MonadReceipt, type Reading } from "@/lib/lab/sponsors";
import { Act, Field, Footnote, Missing, count, gwei, mon, txLink, when } from "./parts";

/**
 * Monad on the receipt.
 *
 * Today the studio stub names the block and stops there, which is true and says
 * nothing about the chain it landed on. The visible take puts the speed and the
 * price of that same send in the reader's face, both measured off the chain.
 */
export function MonadAct({ reading }: { reading: Reading<MonadReceipt> }) {
  return (
    <Act
      index="01"
      sponsor="Monad"
      heading="The receipt says which block. It never says how fast."
      standfirst="Both panes are the newest registration in the registry, read from the chain. The quiet one is the stub the studio stamps today. The loud one is the same transaction with the chain's own speed and price on it."
      quiet={isRead(reading) ? <QuietReceipt receipt={reading.read} /> : <Missing why={reading.failed} />}
      visible={isRead(reading) ? <VisibleReceipt receipt={reading.read} /> : <Missing why={reading.failed} />}
    />
  );
}

/** The stub as it stamps now: sent, then written, and nothing about the chain. */
function QuietReceipt({ receipt }: { receipt: MonadReceipt }) {
  return (
    <div className="relative ps-6">
      <span aria-hidden className="absolute inset-y-0 start-0 border-s border-dashed border-line" />
      <span aria-hidden className="absolute -top-3 -start-3 h-6 w-6 rounded-full border border-line bg-bg" />
      <span aria-hidden className="absolute -bottom-3 -start-3 h-6 w-6 rounded-full border border-line bg-bg" />

      <ol className="space-y-3">
        <li className="border border-line bg-bg p-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-accent">Sent</p>
          <p className="mt-2 break-all font-mono text-xs">{shortHex(receipt.txHash, 10, 8)}</p>
          <p className="mt-1.5 text-xs leading-relaxed text-text-faint">Gas paid by Moolam, not by you.</p>
        </li>
        <li className="border border-line bg-bg p-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-verified">Written to the chain</p>
          <p className="mt-2 font-mono text-xs tabular-nums">Block {count(receipt.block.number)}</p>
          <p className="mt-1.5 text-xs leading-relaxed text-text-faint">{when(receipt.block.timestamp)}</p>
        </li>
      </ol>
    </div>
  );
}

/** The same send, with the two figures the chain can actually prove about it. */
function VisibleReceipt({ receipt }: { receipt: MonadReceipt }) {
  const blocks = Number(receipt.block.number - receipt.span.number);
  const seconds = Number(receipt.block.timestamp - receipt.span.timestamp);

  return (
    <div>
      <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-text-faint">Confirmed on Monad in</p>
      <p className="mt-3 font-display text-[clamp(3.4rem,11vw,7.5rem)] font-semibold uppercase leading-[0.82] tracking-[-0.05em] tabular-nums">
        {count(receipt.blockMs)}
        <span className="ms-3 align-top font-mono text-[clamp(1rem,2.4vw,1.6rem)] tracking-[0.04em] text-accent">ms</span>
      </p>
      <p className="mt-5 max-w-[46ch] text-sm leading-relaxed text-text-muted">
        One block, measured across the {count(BLOCK_TIME_SPAN)} blocks before this registration landed.
      </p>

      <dl className="mt-8 grid gap-x-8 gap-y-6 border-t border-line pt-6 sm:grid-cols-2">
        <Field label="Block" value={count(receipt.block.number)} />
        <Field label="Sealed" value={when(receipt.block.timestamp)} wrap />
        <Field label="The block before it" value={count(receipt.previous.number)} />
        <Field
          label="Its second"
          value={receipt.sameSecond ? `${when(receipt.previous.timestamp)}, the same second` : when(receipt.previous.timestamp)}
          wrap
        />
        <Field label="Window" value={`${count(blocks)} blocks, ${count(seconds)} s`} />
        <Field label="Transaction" value={shortHex(receipt.txHash, 10, 8)} href={txLink(receipt.txHash)} />
      </dl>

      {receipt.gasUsed === null || receipt.gasPrice === null || receipt.feeMon === null ? (
        <p className="mt-8 border-t border-line pt-6 font-mono text-[11px] uppercase tracking-[0.18em] text-failed">
          The receipt for this transaction could not be read, so there is no gas figure
        </p>
      ) : (
        <div className="mt-8 flex flex-wrap items-end gap-x-10 gap-y-4 border-t border-line pt-6">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">Billed</p>
            <p className="mt-2 font-display text-[clamp(1.8rem,4vw,3rem)] font-semibold leading-[0.95] tracking-[-0.04em] tabular-nums">
              {mon(receipt.feeMon)}
              <span className="ms-2 font-mono text-sm tracking-[0.08em] text-accent">MON</span>
            </p>
          </div>
          <p className="font-mono text-xs leading-relaxed text-text-faint tabular-nums">
            {count(receipt.gasUsed)} gas at {gwei(receipt.gasPrice)} gwei
            <br />
            {receipt.feeMon} MON exactly
          </p>
        </div>
      )}

      <Footnote>
        This is block time: how long the chain takes to seal one block, read from the block timestamps around this
        registration. It is not the time from tapping send to seeing the receipt. Monad stamps a block in whole
        seconds, so the block before this one carries the same second and a single pair cannot measure it. Only a live
        send can measure the wallet to receipt time.
      </Footnote>
    </div>
  );
}
