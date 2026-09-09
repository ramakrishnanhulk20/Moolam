import { getFormatter, getTranslations } from "next-intl/server";
import { MONAD_EXPLORER, addresses, shortHex } from "@/lib/chain/client";
import type { Attestation } from "@/lib/chain/registry";
import { transactionFor, type IndexedAttestation } from "./indexed";
import { attestationSource } from "./labels";

/**
 * The trust story, and the loudest block on the page.
 *
 * Anyone can claim their own image is theirs. What makes this a passport is
 * that a second party fetched the picture, hashed it again and wrote the answer
 * back on chain. This block says who that was, how far apart the two hashes
 * were, and lets a reader open the transaction that carried it.
 */
export async function Attestations({
  attestations,
  indexed,
  locale,
}: {
  attestations: Attestation[];
  indexed: IndexedAttestation[];
  locale: string;
}) {
  const t = await getTranslations("passport.attestations");
  const format = await getFormatter({ locale });

  return (
    <section className="border-y border-line bg-bg-raised">
      <div className="mx-auto w-full max-w-[1400px] px-5 py-14 sm:px-8 sm:py-20">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:gap-16">
          <div className="rise">
            <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-text-faint">{t("kicker")}</p>
            <h2 className="mt-5 max-w-[15ch] font-display text-[clamp(1.8rem,4vw,3.2rem)] font-semibold uppercase leading-[0.95] tracking-[-0.03em]">
              {t("heading")}
            </h2>
            <p className="mt-5 max-w-[46ch] text-sm leading-relaxed text-text-muted">{t("body")}</p>
          </div>

          <div className="rise" style={{ animationDelay: "90ms" }}>
            {attestations.length === 0 ? (
              <p className="max-w-[52ch] border-s-2 border-line ps-5 text-sm leading-relaxed text-text-muted">
                {t("empty")}
              </p>
            ) : (
              <ul className="space-y-px bg-line">
                {attestations.map((attestation, index) => (
                  <Row
                    key={`${attestation.receiver}-${attestation.at}-${index}`}
                    attestation={attestation}
                    txHash={transactionFor(indexed, attestation)}
                    when={format.dateTime(new Date(Number(attestation.at) * 1000), {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  />
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

async function Row({
  attestation,
  txHash,
  when,
}: {
  attestation: Attestation;
  txHash?: `0x${string}`;
  when: string;
}) {
  const t = await getTranslations("passport.attestations");
  const common = await getTranslations("common");
  const source = attestationSource(attestation.receiver);

  return (
    <li className="bg-bg p-6 sm:p-8">
      <p className={`flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] ${attestation.matched ? "text-verified" : "text-failed"}`}>
        <span aria-hidden className={`h-2 w-2 ${attestation.matched ? "bg-verified" : "bg-failed"}`} />
        {attestation.matched ? t("matched") : t("notMatched")}
      </p>

      <p className="mt-5 max-w-[24ch] font-display text-[clamp(1.3rem,2.6vw,2rem)] font-semibold leading-[1.05] tracking-[-0.03em]">
        {source === "chainlink" ? t("byChainlink") : t("byReceiver")}
      </p>

      <dl className="mt-7 grid gap-x-8 gap-y-5 border-t border-line pt-5 sm:grid-cols-3">
        <Field label={t("distanceLabel")} value={t("distance", { distance: attestation.distance })} />
        <Field label={t("at")} value={when} />
        <Field label={t("receiver")} value={shortHex(attestation.receiver)} href={`${MONAD_EXPLORER}/address/${attestation.receiver}`} />
      </dl>

      <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2">
        {txHash === undefined ? (
          <p className="font-mono text-[11px] text-text-faint">{t("noTransaction")}</p>
        ) : (
          <a
            href={`${MONAD_EXPLORER}/tx/${txHash}`}
            target="_blank"
            rel="noreferrer"
            className="rounded-[8px] border border-line px-4 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent"
          >
            {t("openTx", { hash: shortHex(txHash) })}
          </a>
        )}
        {source === "chainlink" ? (
          <a
            href={`${MONAD_EXPLORER}/address/${addresses.receiver}`}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[10px] uppercase tracking-[0.18em] text-text-faint transition-colors duration-200 hover:text-accent"
          >
            {common("explorer")}
          </a>
        ) : null}
      </div>

      <p className="mt-6 break-all font-mono text-[11px] text-text-faint">
        {t("recomputed")} {attestation.recomputed}
      </p>
    </li>
  );
}

function Field({ label, value, href }: { label: string; value: string; href?: string }) {
  return (
    <div className="min-w-0">
      <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{label}</dt>
      <dd className="mt-1.5 break-all font-mono text-sm">
        {href === undefined ? (
          value
        ) : (
          <a href={href} target="_blank" rel="noreferrer" className="transition-colors duration-200 hover:text-accent">
            {value}
          </a>
        )}
      </dd>
    </div>
  );
}
