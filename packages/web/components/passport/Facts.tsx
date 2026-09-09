import { getTranslations } from "next-intl/server";
import type { Hex } from "viem";
import { MONAD_EXPLORER, gatewayUrl } from "@/lib/chain/client";
import type { Passport } from "@/lib/chain/registry";
import { Link } from "@/lib/i18n/routing";
import type { Art } from "./art";

/**
 * Everything the record itself says, in two columns that do not match: who and
 * when on the wide side, the hashes on the narrow one. The hashes are the part
 * a verifier recomputes, so they are shown in full rather than shortened.
 */
export async function Facts({
  passport,
  art,
  owner,
  hasPasskey,
}: {
  passport: Passport;
  art: Art;
  owner: Hex | null;
  hasPasskey: boolean;
}) {
  const t = await getTranslations("passport");
  const common = await getTranslations("common");

  return (
    <div className="mx-auto grid w-full max-w-[1400px] gap-12 px-5 py-16 sm:px-8 sm:py-24 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,0.75fr)] lg:gap-20">
      <section className="rise">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.28em] text-text-faint">{t("record")}</h2>

        <dl className="mt-8 space-y-8">
          <div>
            <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("creator")}</dt>
            <dd className="mt-2">
              <a
                href={`${MONAD_EXPLORER}/address/${passport.creator}`}
                target="_blank"
                rel="noreferrer"
                className="break-all font-mono text-base transition-colors duration-200 hover:text-accent"
              >
                {passport.creator}
              </a>
              <p className={`mt-2 text-sm leading-relaxed ${hasPasskey ? "text-verified" : "text-text-muted"}`}>
                {hasPasskey ? t("passkeyBound") : t("passkeyNone")}
              </p>
            </dd>
          </div>

          <div>
            <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("owner")}</dt>
            <dd className="mt-2 break-all font-mono text-base">
              {owner === null ? (
                common("unknown")
              ) : (
                <a
                  href={`${MONAD_EXPLORER}/address/${owner}`}
                  target="_blank"
                  rel="noreferrer"
                  className="transition-colors duration-200 hover:text-accent"
                >
                  {owner}
                </a>
              )}
            </dd>
          </div>

          <div>
            <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("agent")}</dt>
            <dd className="mt-2">
              {passport.generatorAgentId === 0n ? (
                <p className="max-w-[46ch] text-sm leading-relaxed text-text-muted">{t("noAgent")}</p>
              ) : (
                <Link
                  href={`/agent/${passport.generatorAgentId.toString()}`}
                  className="font-mono text-base text-accent underline decoration-accent/40 underline-offset-4 transition-colors duration-200 hover:decoration-accent"
                >
                  {t("agentNumber", { id: passport.generatorAgentId.toString() })}
                </Link>
              )}
            </dd>
          </div>

          {art.description === undefined ? null : (
            <div>
              <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("about")}</dt>
              <dd className="mt-2 max-w-[64ch] text-base leading-relaxed text-text-muted">{art.description}</dd>
            </div>
          )}

          {art.prompt === undefined ? null : (
            <div>
              <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("prompt")}</dt>
              <dd className="mt-3 max-w-[64ch] border-s-2 border-accent/50 ps-5 text-base leading-relaxed text-text">
                {art.prompt}
              </dd>
            </div>
          )}
        </dl>
      </section>

      <section className="rise lg:border-s lg:border-line lg:ps-12" style={{ animationDelay: "90ms" }}>
        <h2 className="font-mono text-[11px] uppercase tracking-[0.28em] text-text-faint">{t("fingerprints")}</h2>
        <p className="mt-5 max-w-[40ch] text-sm leading-relaxed text-text-muted">{t("fingerprintsBody")}</p>

        <dl className="mt-8 space-y-6">
          <Hash label={t("phash")} value={`0x${passport.phash.toString(16).padStart(16, "0")}`} />
          <Hash label={t("blockhash")} value={passport.blockhash256} />
          <Hash label={t("exactHash")} value={passport.exactHash} />
          <Hash label={t("manifestHash")} value={passport.manifestHash} />
          <div>
            <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("metadata")}</dt>
            <dd className="mt-1.5 break-all font-mono text-xs leading-relaxed">
              <a
                href={gatewayUrl(passport.metadataURI)}
                target="_blank"
                rel="noreferrer"
                className="text-text-muted transition-colors duration-200 hover:text-accent"
              >
                {passport.metadataURI}
              </a>
            </dd>
          </div>
          <div>
            <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("passportId")}</dt>
            <dd className="mt-1.5 break-all font-mono text-xs leading-relaxed text-text-muted">{passport.id}</dd>
          </div>
        </dl>

        <p className="mt-8 font-mono text-[10px] uppercase tracking-[0.18em] text-text-faint">
          {t("tokenId")}
        </p>
      </section>
    </div>
  );
}

function Hash({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{label}</dt>
      <dd className="mt-1.5 break-all font-mono text-xs leading-relaxed text-text">{value}</dd>
    </div>
  );
}
