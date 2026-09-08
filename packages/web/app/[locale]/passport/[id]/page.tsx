import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import type { Hex } from "viem";
import { MONAD_EXPLORER, addresses, gatewayUrl, reason, shortHex } from "@/lib/chain/client";
import { ZERO_ID, getAttestations, getChildren, getOwner, getPassport } from "@/lib/chain/registry";
import type { Attestation, Passport } from "@/lib/chain/registry";
import { Link } from "@/lib/i18n/routing";

const ID_PATTERN = /^0x[0-9a-fA-F]{64}$/;

export default async function PassportPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("passport");

  if (!ID_PATTERN.test(id)) {
    return <Notice text={t("notFound")} />;
  }

  let passport: Passport | null;
  let attestations: Attestation[] = [];
  let edits: Hex[] = [];
  let owner: Hex | null = null;

  try {
    passport = await getPassport(id as Hex);
    if (passport !== null) {
      [attestations, edits, owner] = await Promise.all([
        getAttestations(id as Hex),
        getChildren(id as Hex),
        getOwner(id as Hex),
      ]);
    }
  } catch (error) {
    return <Notice text={t("error", { reason: reason(error) })} tone="failed" />;
  }

  if (passport === null) {
    return <Notice text={t("notFound")} />;
  }

  return (
    <Record passport={passport} attestations={attestations} edits={edits} owner={owner} locale={locale} />
  );
}

async function Record({
  passport,
  attestations,
  edits,
  owner,
  locale,
}: {
  passport: Passport;
  attestations: Attestation[];
  edits: Hex[];
  owner: Hex | null;
  locale: string;
}) {
  const t = await getTranslations("passport");
  const common = await getTranslations("common");
  const kinds = await getTranslations("kind");
  const format = await getFormatter({ locale });
  const when = format.dateTime(new Date(Number(passport.registeredAt) * 1000), {
    dateStyle: "medium",
    timeStyle: "short",
  });

  const fields: { label: string; value: string; href?: string; mono?: boolean }[] = [
    {
      label: t("creator"),
      value: passport.creator,
      href: `${MONAD_EXPLORER}/address/${passport.creator}`,
      mono: true,
    },
    owner === null
      ? { label: t("owner"), value: common("unknown") }
      : { label: t("owner"), value: owner, href: `${MONAD_EXPLORER}/address/${owner}`, mono: true },
    { label: t("registered"), value: when },
    { label: t("kind"), value: kinds(String(passport.kind)) },
    { label: t("phash"), value: `0x${passport.phash.toString(16).padStart(16, "0")}`, mono: true },
    { label: t("blockhash"), value: passport.blockhash256, mono: true },
    { label: t("manifestHash"), value: passport.manifestHash, mono: true },
    { label: t("metadata"), value: passport.metadataURI, href: gatewayUrl(passport.metadataURI), mono: true },
    { label: t("disputed"), value: passport.disputed ? common("yes") : common("no") },
  ];

  return (
    <article className="mx-auto w-full max-w-[1400px] px-5 py-16 sm:px-8 sm:py-24">
      <header className="rise max-w-[62ch]">
        <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-text-faint">{t("title")}</p>
        <h1 className="mt-4 break-all font-mono text-[clamp(1.3rem,3.2vw,2.5rem)] leading-[1.05] text-text">
          {passport.id}
        </h1>
        <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <Link
            href={`/agent/${passport.generatorAgentId.toString()}`}
            className="text-accent underline decoration-accent/40 underline-offset-4 transition-colors duration-200 hover:decoration-accent"
          >
            {t("agent")} {passport.generatorAgentId.toString()}
          </Link>
          <a
            href={`${MONAD_EXPLORER}/address/${addresses.registry}`}
            target="_blank"
            rel="noreferrer"
            className="text-text-muted transition-colors duration-200 hover:text-accent"
          >
            {common("explorer")}
          </a>
          {passport.parentId === ZERO_ID ? null : (
            <Link
              href={`/passport/${passport.parentId}`}
              className="text-text-muted transition-colors duration-200 hover:text-accent"
            >
              {t("parent")} {shortHex(passport.parentId)}
            </Link>
          )}
        </div>
      </header>

      <dl
        className="rise mt-14 grid gap-x-10 gap-y-6 border-t border-line pt-8 sm:grid-cols-2 lg:grid-cols-3"
        style={{ animationDelay: "80ms" }}
      >
        {fields.map((field) => (
          <div key={field.label}>
            <dt className="font-mono text-[11px] uppercase tracking-[0.18em] text-text-faint">{field.label}</dt>
            <dd className={field.mono ? "mt-1.5 break-all font-mono text-sm" : "mt-1.5 break-all text-sm"}>
              {field.href === undefined ? (
                field.value
              ) : (
                <a
                  href={field.href}
                  target="_blank"
                  rel="noreferrer"
                  className="transition-colors duration-200 hover:text-accent"
                >
                  {field.value}
                </a>
              )}
            </dd>
          </div>
        ))}
      </dl>

      <div className="mt-16 grid gap-14 lg:grid-cols-[1.4fr_1fr]">
        <section className="rise" style={{ animationDelay: "160ms" }}>
          <h2 className="font-display text-2xl uppercase tracking-[0.04em]">{t("attestations.heading")}</h2>
          {attestations.length === 0 ? (
            <p className="mt-4 max-w-[52ch] text-sm text-text-muted">{t("attestations.empty")}</p>
          ) : (
            <ul className="mt-6 space-y-4">
              {attestations.map((attestation, index) => (
                <li key={`${attestation.receiver}-${index}`} className="border border-line bg-bg-raised p-5">
                  <p className={attestation.matched ? "text-verified" : "text-failed"}>
                    {attestation.matched ? t("attestations.matched") : t("attestations.notMatched")}
                    <span className="ml-2 text-text-muted">
                      {t("attestations.distance", { distance: attestation.distance })}
                    </span>
                  </p>
                  <p className="mt-2 break-all font-mono text-xs text-text-faint">
                    {t("attestations.receiver")} {attestation.receiver}
                  </p>
                  <p className="mt-1 font-mono text-xs text-text-faint">
                    {t("attestations.at")}{" "}
                    {format.dateTime(new Date(Number(attestation.at) * 1000), {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rise" style={{ animationDelay: "240ms" }}>
          <h2 className="font-display text-2xl uppercase tracking-[0.04em]">{t("children.heading")}</h2>
          {edits.length === 0 ? (
            <p className="mt-4 max-w-[46ch] text-sm text-text-muted">{t("children.empty")}</p>
          ) : (
            <ul className="mt-6 space-y-3">
              {edits.map((child) => (
                <li key={child}>
                  <Link
                    href={`/passport/${child}`}
                    className="block break-all border-l-2 border-line pl-4 font-mono text-xs text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent"
                  >
                    {child}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </article>
  );
}

function Notice({ text, tone }: { text: string; tone?: "failed" }) {
  return (
    <div className="mx-auto w-full max-w-[1400px] px-5 py-24 sm:px-8">
      <p className={tone === "failed" ? "rise max-w-[52ch] text-base text-failed" : "rise max-w-[52ch] text-base text-text-muted"}>
        {text}
      </p>
    </div>
  );
}
