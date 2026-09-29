import { getTranslations } from "next-intl/server";
import { MONAD_EXPLORER, addresses, gatewayUrl, shortHex } from "@/lib/chain/client";
import { cidOf, pinnedUri } from "@/components/passport/art";
import { HEX_MARK, withHex } from "@/components/agents/hex";
import { Mono } from "@/components/passport/Mono";
import { cardText, type AgentCard } from "./card";

/**
 * How a passport gets this agent's name on it, and only what the code proves.
 *
 * The registry recovers the generator signature and compares the recovered
 * address with ownerOf on the ERC-8004 identity registry, so an agent id is
 * worth exactly as much as the wallet that owns it. The Privy line only appears
 * when the agent's own card records a wallet or a policy: this app does not
 * claim where a key lives.
 */
export async function Signing({
  agentId,
  card,
  document,
  uri,
}: {
  agentId: bigint;
  card: AgentCard | null;
  /** The card exactly as it was read, for the disclosure. */
  document: unknown;
  uri: string;
}) {
  const t = await getTranslations("agent.signs");
  const a = await getTranslations("agent");
  const steps = ["sign", "recover", "own"] as const;
  const inline = uri.startsWith("data:");
  const json = cardText(document);
  const cid = cidOf(uri);
  const pinned = pinnedUri(uri);

  return (
    <section className="mx-auto w-full max-w-[1400px] px-5 py-16 sm:px-8 sm:py-24">
      <div className="grid gap-12 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-20">
        <div className="rise">
          <h2 className="max-w-[14ch] font-display text-[clamp(1.8rem,4vw,3rem)] font-semibold uppercase leading-[0.95] tracking-[-0.03em]">
            {t("heading")}
          </h2>
          <p className="mt-6 max-w-[46ch] text-base leading-relaxed text-text-muted">{t("body")}</p>
        </div>

        <div className="rise" style={{ animationDelay: "90ms" }}>
          <ol className="border-t border-line">
            {steps.map((step, index) => (
              <li key={step} className="flex items-start gap-6 border-b border-line py-6">
                <span className="mt-1 font-mono text-[11px] tabular-nums text-accent">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <div className="min-w-0">
                  <p className="font-display text-lg leading-snug tracking-[-0.01em]">{t(`${step}.title`)}</p>
                  <p className="mt-2 max-w-[56ch] text-base leading-relaxed text-text-muted">
                    {t(`${step}.body`, { id: agentId.toString() })}
                  </p>
                </div>
              </li>
            ))}
          </ol>

          <div className="mt-8 flex flex-wrap items-center gap-x-8 gap-y-3 font-mono text-[10px] uppercase tracking-[0.18em] text-text-faint">
            <a
              href={`${MONAD_EXPLORER}/address/${addresses.registry}`}
              target="_blank"
              rel="noreferrer"
              className="transition-colors duration-200 hover:text-accent"
            >
              {withHex(t("registry", { address: HEX_MARK }), shortHex(addresses.registry))}
            </a>
            <a
              href={`${MONAD_EXPLORER}/address/${addresses.agentIdentity}`}
              target="_blank"
              rel="noreferrer"
              className="transition-colors duration-200 hover:text-accent"
            >
              {withHex(t("identity", { address: HEX_MARK }), shortHex(addresses.agentIdentity))}
            </a>
          </div>

          <div className="mt-6">
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{a("cardLabel")}</p>
            {inline ? (
              <>
                {/* A card carried inside the token URI is a wall of base64. The
                    document it decodes to is the useful thing, and it stays
                    folded away until a reader asks for it. */}
                <p className="mt-1.5 max-w-[52ch] text-base leading-relaxed text-text-muted">{a("cardInline")}</p>
                {json === null ? null : (
                  <details className="mt-3 border border-line bg-bg-raised">
                    <summary className="cursor-pointer px-4 py-3 font-mono text-[10px] uppercase tracking-[0.18em] text-text-muted transition-colors duration-200 hover:text-accent">
                      {a("cardShow")}
                    </summary>
                    <pre className="max-h-[22rem] overflow-auto border-t border-line px-4 py-4 font-mono text-[11px] leading-relaxed text-text-muted">
                      {json}
                    </pre>
                  </details>
                )}
              </>
            ) : (
              <p className="mt-1.5">
                {/* The token URI is whatever the agent's owner wrote. Only a
                    pinned file becomes a link, read through Moolam's gateway;
                    any other address is shown as text a visitor can read but
                    never be sent to. */}
                {pinned === undefined ? (
                  <span className="text-text-muted">
                    <Mono value={cid === null ? uri : a("ipfsCid", { cid })} className="text-xs leading-relaxed" />
                  </span>
                ) : (
                  <a
                    href={gatewayUrl(pinned)}
                    target="_blank"
                    rel="noreferrer"
                    className="text-text-muted transition-colors duration-200 hover:text-accent"
                  >
                    <Mono value={cid === null ? uri : a("ipfsCid", { cid })} className="text-xs leading-relaxed" />
                  </a>
                )}
              </p>
            )}
          </div>

          {card?.privy == null ? null : (
            <div className="mt-10 border border-line bg-bg-raised p-6">
              <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-text-faint">{t("privy")}</p>
              <p className="mt-4 max-w-[52ch] text-base leading-relaxed text-text-muted">{t("privyBody")}</p>
              <dl className="mt-5 space-y-4">
                {card.privy.walletId === undefined ? null : (
                  <div>
                    <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">
                      {t("privyWallet")}
                    </dt>
                    <dd className="mt-1.5 break-all font-mono text-sm normal-case">{card.privy.walletId}</dd>
                  </div>
                )}
                {card.privy.policyIds.length === 0 ? null : (
                  <div>
                    <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">
                      {t("privyPolicy")}
                    </dt>
                    <dd className="mt-1.5 space-y-1 break-all font-mono text-sm normal-case">
                      {card.privy.policyIds.map((policy) => (
                        <p key={policy}>{policy}</p>
                      ))}
                    </dd>
                  </div>
                )}
              </dl>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
