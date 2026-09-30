import { getFormatter, getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { getAddress, type Hex } from "viem";
import { MONAD_EXPLORER, addresses, gatewayUrl, shortHex } from "@/lib/chain/client";
import type { Passport } from "@/lib/chain/registry";
import { CopyButton } from "@/components/studio/CopyButton";
import { Link } from "@/lib/i18n/routing";
import type { PlatformLabel } from "@/lib/platforms/platforms";
import type { SealedCopyLookup } from "@/lib/verifier/client";
import { aboutLine } from "./about";
import { cidOf, pinnedUri, type Art } from "./art";
import { Mono } from "./Mono";
import { standingClass, type Standing } from "./labels";
import { ANCHOR_MARGIN, FACT_ANCHORS } from "./top-facts";

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
  privateCopy,
  platform = null,
  agentName = null,
}: {
  passport: Passport;
  art: Art;
  owner: Hex | null;
  hasPasskey: boolean;
  standing: Standing;
  txHash: Hex | null;
  /** Whether Moolam still keeps a sealed picture's private copy, when the page asked. */
  privateCopy?: SealedCopyLookup["state"];
  /** What Moolam's signed platform list says about this passport, from lib/data/platform-label.ts only. */
  platform?: PlatformLabel | null;
  /** The name the agent's own ERC-8004 card gives itself, or null when it names nothing or would not load. */
  agentName?: string | null;
}) {
  const t = await getTranslations("passport");
  const common = await getTranslations("common");
  const format = await getFormatter();
  const tokenId = BigInt(passport.id).toString();
  const metadataCid = cidOf(passport.metadataURI);
  const imageCid = art.imageUrl === undefined ? null : cidOf(art.imageUrl);
  const about = aboutLine(art, privateCopy);
  // The chain and the record beside it can name any address at all. Only a
  // pinned file is linked, through Moolam's own gateway; anything else is
  // shown as text and never becomes a link a visitor's browser follows.
  const metadataLink = pinnedUri(passport.metadataURI);
  const unsealedLink = art.unsealed === undefined ? undefined : pinnedUri(art.unsealed.record.uri);

  return (
    <div className="mx-auto grid w-full max-w-[1400px] gap-12 px-5 py-16 sm:px-8 sm:py-24 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,0.75fr)] lg:gap-20">
      <section className="rise">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.28em] text-text-faint">{t("record")}</h2>
          {/* A sealed passport has never been re-checked and never will be
              while it stays sealed, so "Not re-checked yet" would read as a
              fault the holder could fix. It says what it is instead, in the
              same cold ink as the rest of the standing family. */}
          <p
            className={`border border-line bg-bg-raised px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] ${
              art.sealed === true && standing === "unverified" ? "text-text-muted" : standingClass(standing)
            }`}
          >
            {art.sealed === true && standing === "unverified" ? t("sealed.standing") : t(`standing.${standing}`)}
          </p>
        </div>

        <dl className="mt-8 space-y-8">
          <div id={FACT_ANCHORS.madeBy} style={ANCHOR_MARGIN}>
            <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("creator")}</dt>
            <dd className="mt-2">
              <span className="tap-row flex flex-wrap items-center gap-x-3 gap-y-2">
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
              <p className={`mt-2 text-base leading-relaxed ${hasPasskey ? "text-verified" : "text-text-muted"}`}>
                {hasPasskey ? t("passkeyBound") : t("passkeyNone")}
              </p>
              {/* An addition to the words above, never a replacement: without
                  the list this passport still reads true, it only loses the
                  name. */}
              {platform === null ? null : platform.status === "kit" ? (
                <div data-platform="kit" className="mt-4 max-w-[58ch] border-s-2 border-accent/60 ps-5">
                  <p className="flex items-center gap-2.5 font-display text-[17px] font-semibold leading-snug tracking-[-0.01em] text-text">
                    <span aria-hidden className="motif h-[8px] w-[8px] shrink-0" />
                    {t("platform.kit", { platform: platform.name })}
                  </p>
                  <p className="mt-2 text-base leading-relaxed text-text-muted">
                    {t("platform.kitNote", { platform: platform.name })}
                  </p>
                </div>
              ) : (
                <p
                  data-platform="outsideKit"
                  className="mt-4 max-w-[58ch] border-s-2 border-line-strong ps-5 text-base leading-relaxed text-text-muted"
                >
                  {t("platform.outsideKit", { platform: platform.name })}
                </p>
              )}
            </dd>
          </div>

          <div>
            <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("owner")}</dt>
            <dd className="mt-2">
              {owner === null ? (
                <span className="font-mono text-base">{common("unknown")}</span>
              ) : (
                <span className="tap-row flex flex-wrap items-center gap-x-3 gap-y-2">
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
              {owner !== null && heldElsewhere(passport.creator, owner) ? (
                <p data-holder-differs className="mt-2 max-w-[58ch] text-base leading-relaxed text-text-muted">
                  {t("holder.differs", { creator: shortHex(passport.creator), holder: shortHex(owner) })}
                </p>
              ) : null}
            </dd>
          </div>

          <div id={FACT_ANCHORS.drawnBy} style={ANCHOR_MARGIN}>
            <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("agent")}</dt>
            <dd className="mt-2">
              {passport.generatorAgentId === 0n ? (
                <p className="max-w-[46ch] text-base leading-relaxed text-text-muted">{t("noAgent")}</p>
              ) : (
                <Link
                  href={`/agent/${passport.generatorAgentId.toString()}`}
                  className="tap font-mono text-base text-accent underline decoration-accent/40 underline-offset-4 transition-colors duration-200 hover:decoration-accent"
                >
                  {t("agentNumber", { id: passport.generatorAgentId.toString() })}
                </Link>
              )}
              {/* Two names, two trust levels, never one line (P14). The first
                  is Moolam's signed list speaking; the second is whatever the
                  agent's owner wrote on its card. */}
              {passport.generatorAgentId !== 0n && platform?.status === "kit" ? (
                <p data-agent-listed className="mt-3 flex max-w-[58ch] items-center gap-2.5 text-base leading-relaxed text-text">
                  <span aria-hidden className="motif h-[7px] w-[7px] shrink-0" />
                  {t("agentListed", { platform: platform.name })}
                </p>
              ) : null}
              {passport.generatorAgentId !== 0n && agentName !== null && agentName.trim() !== "" ? (
                <p data-agent-self-declared className="mt-2 max-w-[58ch] text-base leading-relaxed text-text-muted">
                  {t("agentSelfDeclared", { name: agentName.trim() })}
                </p>
              ) : null}
            </dd>
          </div>

          {about === null ? null : (
            <div>
              <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("about")}</dt>
              <dd
                data-about={about.kind === "sealed" ? about.key : "pinned"}
                className="mt-2 max-w-[64ch] text-base leading-relaxed text-text-muted"
              >
                {about.kind === "pinned"
                  ? about.text
                  : about.key === "published"
                    ? t("sealed.about.published", {
                        date: format.dateTime(new Date(about.at), { dateStyle: "medium" }),
                      })
                    : t(`sealed.about.${about.key}`)}
              </dd>
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

          {/* Where the picture's own address would be on a published record,
              a sealed one says what the chain is holding instead: the hash of
              the file the creator kept. It is not a link, because there is
              nothing at the other end of it by design. */}
          {art.sealed === true ? (
            <div className="mt-7 max-w-[54ch] border-s-2 border-accent/50 ps-5">
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">
                {t("sealed.commitmentLabel")}
              </p>
              <div className="tap-row mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
                <Mono value={passport.id} className="min-w-0 text-xs leading-relaxed text-text" />
                <CopyButton value={passport.id} />
              </div>
              <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.18em] text-text-faint">
                {/* The registry's own rule is that a passport id is the sha-256
                    of the registered file, so that is what stands when the
                    pinned document does not name the algorithm itself. */}
                {t("sealed.commitmentAlgorithm", { algorithm: art.commitment?.algorithm ?? "sha-256" })}
              </p>
              <p className="mt-4 text-base leading-relaxed text-text-muted">{t("sealed.commitmentLine")}</p>
            </div>
          ) : art.unsealed === undefined ? null : (
            // The other end of the same story. This picture has an address like
            // any other, and the one thing a reader would not otherwise know is
            // that it was held back at registration and published later by the
            // wallet that holds it. The record that says so is linked, because
            // anybody can open it and hash the picture themselves.
            <div className="mt-7 max-w-[54ch] border-s-2 border-accent/50 ps-5">
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">
                {t("unsealed.label")}
              </p>
              <p className="mt-2 text-base leading-relaxed text-text-muted">
                {t("unsealed.line", {
                  date: format.dateTime(new Date(art.unsealed.at), { dateStyle: "medium" }),
                })}
              </p>
              <div className="tap-row mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
                <AddressLink href={unsealedLink === undefined ? undefined : gatewayUrl(unsealedLink)}>
                  <Mono
                    value={t("ipfsCid", { cid: art.unsealed.record.cid })}
                    className="text-xs leading-relaxed"
                  />
                </AddressLink>
                <CopyButton value={art.unsealed.record.uri} />
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="rise lg:border-s lg:border-line lg:ps-12" style={{ animationDelay: "90ms" }}>
        {/* The method sits with the values it produced: a verifier needs both to
            recompute them, and on the poster it read as a credit. */}
        <div className="flex flex-wrap items-baseline justify-between gap-x-5 gap-y-2">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.28em] text-text-faint">{t("fingerprints")}</h2>
          <p data-fingerprint-version className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-muted">
            {t("fingerprintVersion", { version: passport.fingerprintVersion })}
          </p>
        </div>
        {/* The paragraph says anyone can fetch the picture and re-check it, which
            is untrue of a sealed one. That passport's commitment line in the
            record already says what can be compared, so it gets nothing here. */}
        {art.sealed === true ? null : (
          <p data-fingerprints-body className="mt-5 max-w-[40ch] text-base leading-relaxed text-text-muted">
            {t("fingerprintsBody")}
          </p>
        )}

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
            <dd className="tap-row mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-2">
              <AddressLink href={metadataLink === undefined ? undefined : gatewayUrl(metadataLink)}>
                <Mono
                  value={metadataCid === null ? passport.metadataURI : t("ipfsCid", { cid: metadataCid })}
                  className="text-xs leading-relaxed"
                />
              </AddressLink>
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

/**
 * True when the wallet holding the passport now is not the one that registered
 * it. Both go through getAddress so a checksum difference is never read as a
 * transfer; anything that is not an address is left unsaid.
 */
export function heldElsewhere(creator: string, holder: string): boolean {
  try {
    return getAddress(creator) !== getAddress(holder);
  } catch {
    return false;
  }
}

/** A stored address, as a link when it passed the pinned-file rule and as plain text when it did not. */
function AddressLink({ href, children }: { href: string | undefined; children: ReactNode }) {
  if (href === undefined) {
    return <span className="min-w-0 text-text-muted">{children}</span>;
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="min-w-0 text-text-muted transition-colors duration-200 hover:text-accent"
    >
      {children}
    </a>
  );
}

function Elsewhere({ href, label, detail }: { href: string; label: string; detail?: string }) {
  return (
    <li>
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="tap group flex items-center gap-3 rounded-[8px] border border-line bg-bg-raised px-4 py-3 transition-colors duration-200 hover:border-accent"
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
      <dd className="tap-row mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-2">
        <Mono value={value} className="min-w-0 text-xs leading-relaxed text-text" />
        <CopyButton value={value} />
      </dd>
      {note === undefined ? null : <p className="mt-2 max-w-[40ch] text-base leading-relaxed text-text-muted">{note}</p>}
    </div>
  );
}
