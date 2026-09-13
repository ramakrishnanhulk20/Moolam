import { getTranslations } from "next-intl/server";
import type { Hex } from "viem";
import { MONAD_EXPLORER, addresses, gatewayUrl, shortHex } from "@/lib/chain/client";
import type { Passport } from "@/lib/chain/registry";
import { CopyButton } from "@/components/studio/CopyButton";
import { Link } from "@/lib/i18n/routing";
import { cidOf, type Art } from "./art";
import { Mono } from "./Mono";
import { standingClass, type Standing } from "./labels";

/** A manifest hash of nothing but zeroes means no C2PA manifest was embedded. */
function hasManifest(manifestHash: string): boolean {
  return !/^0x0*$/.test(manifestHash);
}

/**
 * Everything the record itself says, in two columns that do not match: who and
 * when on the wide side, the hashes on the narrow one. The hashes are the part
 * a verifier recomputes, so they are shown in full rather than shortened, and
 * every one of them can be copied.
 *
 * Where this record stands is stated here rather than over the picture: on the
 * poster it sat on whatever the image happened to be, which for a bright still
 * meant pale grey type on a pale sky.
 */
export async function Facts({
  passport,
  art,
  owner,
  hasPasskey,
  standing,
  txHash,
}: {
  passport: Passport;
  art: Art;
  owner: Hex | null;
  hasPasskey: boolean;
  standing: Standing;
  txHash: Hex | null;
}) {
  const t = await getTranslations("passport");
  const common = await getTranslations("common");
  const tokenId = BigInt(passport.id).toString();
  const metadataCid = cidOf(passport.metadataURI);
  const imageCid = art.imageUrl === undefined ? null : cidOf(art.imageUrl);

  return (
    <div className="mx-auto grid w-full max-w-[1400px] gap-12 px-5 py-16 sm:px-8 sm:py-24 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,0.75fr)] lg:gap-20">
      <section className="rise">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.28em] text-text-faint">{t("record")}</h2>
          <p
            className={`border border-line bg-bg-raised px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] ${standingClass(standing)}`}
          >
            {t(`standing.${standing}`)}
          </p>
        </div>

        <dl className="mt-8 space-y-8">
          <div>
            <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("creator")}</dt>
            <dd className="mt-2">
              <span className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <a
                  href={`${MONAD_EXPLORER}/address/${passport.creator}`}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 transition-colors duration-200 hover:text-accent"
                >
                  <Mono value={passport.creator} className="text-base" />
                </a>
                <CopyButton value={passport.creator} />
              </span>
              <p className={`mt-2 text-sm leading-relaxed ${hasPasskey ? "text-verified" : "text-text-muted"}`}>
                {hasPasskey ? t("passkeyBound") : t("passkeyNone")}
              </p>
            </dd>
          </div>

          <div>
            <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("owner")}</dt>
            <dd className="mt-2">
              {owner === null ? (
                <span className="font-mono text-base">{common("unknown")}</span>
              ) : (
                <span className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <a
                    href={`${MONAD_EXPLORER}/address/${owner}`}
                    target="_blank"
                    rel="noreferrer"
                    className="min-w-0 transition-colors duration-200 hover:text-accent"
                  >
                    <Mono value={owner} className="text-base" />
                  </a>
                  <CopyButton value={owner} />
                </span>
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

        {/* The three places this record exists outside this page. The
            transaction only exists in the index, so it is offered when the
            index has it and left out rather than faked when it does not. */}
        <div className="mt-12 border-t border-line pt-8">
          <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-text-faint">{t("elsewhere")}</p>
          <ul className="mt-5 flex flex-wrap gap-3">
            {txHash === null ? null : (
              <Elsewhere href={`${MONAD_EXPLORER}/tx/${txHash}`} label={t("openTransaction")} detail={shortHex(txHash, 8, 6)} />
            )}
            <Elsewhere
              href={`${MONAD_EXPLORER}/nft/${addresses.registry}/${tokenId}`}
              label={t("openToken")}
              detail={shortHex(passport.id, 8, 6)}
            />
            {art.imageUrl === undefined ? null : (
              <Elsewhere
                href={art.imageUrl}
                label={t("openImage")}
                detail={imageCid === null ? undefined : shortHex(imageCid, 6, 4)}
              />
            )}
          </ul>
        </div>
      </section>

      <section className="rise lg:border-s lg:border-line lg:ps-12" style={{ animationDelay: "90ms" }}>
        <h2 className="font-mono text-[11px] uppercase tracking-[0.28em] text-text-faint">{t("fingerprints")}</h2>
        <p className="mt-5 max-w-[40ch] text-sm leading-relaxed text-text-muted">{t("fingerprintsBody")}</p>

        <dl className="mt-8 space-y-6">
          <Hash label={t("phash")} value={`0x${passport.phash.toString(16).padStart(16, "0")}`} />
          <Hash label={t("blockhash")} value={passport.blockhash256} />
          <Hash label={t("exactHash")} value={passport.exactHash} />
          <Hash
            label={t("manifestHash")}
            value={passport.manifestHash}
            note={hasManifest(passport.manifestHash) ? undefined : t("noManifest")}
          />
          <div>
            <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("metadata")}</dt>
            <dd className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-2">
              <a
                href={gatewayUrl(passport.metadataURI)}
                target="_blank"
                rel="noreferrer"
                className="min-w-0 text-text-muted transition-colors duration-200 hover:text-accent"
              >
                <Mono
                  value={metadataCid === null ? passport.metadataURI : t("ipfsCid", { cid: metadataCid })}
                  className="text-xs leading-relaxed"
                />
              </a>
              <CopyButton value={passport.metadataURI} />
            </dd>
          </div>
          <Hash label={t("passportId")} value={passport.id} />
        </dl>

        <p className="mt-8 font-mono text-[10px] uppercase tracking-[0.18em] text-text-faint">{t("tokenId")}</p>
      </section>
    </div>
  );
}

function Elsewhere({ href, label, detail }: { href: string; label: string; detail?: string }) {
  return (
    <li>
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="group flex items-center gap-3 rounded-[8px] border border-line bg-bg-raised px-4 py-3 transition-colors duration-200 hover:border-accent"
      >
        <span className="motif h-[8px] w-[8px] opacity-60 transition-opacity duration-200 group-hover:opacity-100" />
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-text transition-colors duration-200 group-hover:text-accent">
          {label}
        </span>
        {detail === undefined ? null : <span className="font-mono text-[10px] text-text-muted">{detail}</span>}
      </a>
    </li>
  );
}

function Hash({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div>
      <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{label}</dt>
      <dd className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-2">
        <Mono value={value} className="min-w-0 text-xs leading-relaxed text-text" />
        <CopyButton value={value} />
      </dd>
      {note === undefined ? null : <p className="mt-2 max-w-[40ch] text-sm leading-relaxed text-text-muted">{note}</p>}
    </div>
  );
}
