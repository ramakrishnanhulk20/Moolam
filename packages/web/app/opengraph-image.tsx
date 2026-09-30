import { readFile } from "node:fs/promises";
import { ImageResponse } from "next/og";
import type { AbiEvent } from "viem";
import { DEPLOY_BLOCK, addresses, chain, registryAbi } from "@/lib/chain/client";
import { activeSource, envioUrl } from "@/lib/data/source";

export const alt = "Moolam: every image gets a passport";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// The count is read when the card is drawn, and the drawn card is then held for
// an hour: an unfurl in a chat has to come back inside a second, and a figure
// that is up to an hour old is still the registry's own. The header is what the
// cache in front of this route reads; the segment setting is for the times Next
// can hold the picture itself.
export const revalidate = 3600;
const CARD_HEADERS = { "cache-control": "public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400" };

const ACCENT = "#FFB7C5";
const GROUND = "#0B0B0C";
const COUNT_TIMEOUT_MS = 6_000;

const registeredEvent = (registryAbi as AbiEvent[]).find(
  (item) => item.type === "event" && item.name === "PassportRegistered",
) as AbiEvent;

/**
 * How many passports the registry holds, from the index if one is live and from
 * the registry's own events if not.
 *
 * Returns null when neither answers. The card then carries no figure at all,
 * because a made up number on the picture that gets pasted into a chat is the
 * one thing this whole product argues against.
 */
async function passportCount(): Promise<number | null> {
  if (activeSource() === "envio") {
    try {
      const response = await fetch(envioUrl(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "query Card { GlobalStats { passports } }" }),
        signal: AbortSignal.timeout(COUNT_TIMEOUT_MS),
        cache: "no-store",
      });
      if (response.ok) {
        const body = (await response.json()) as { data?: { GlobalStats: { passports: number }[] } };
        const held = body.data?.GlobalStats[0]?.passports;
        if (typeof held === "number") {
          return held;
        }
      }
    } catch {
      // The chain itself is asked next.
    }
  }

  try {
    const logs = await chain.getLogs({
      address: addresses.registry,
      event: registeredEvent,
      fromBlock: DEPLOY_BLOCK,
      toBlock: await chain.getBlockNumber(),
    });
    return logs.length;
  } catch {
    return null;
  }
}

/**
 * The card's face, subset to the few glyphs it sets.
 *
 * next/font packs Archivo for the browser, which is not something the image
 * renderer can read, so the same family is fetched here, once per weight. The
 * two weights are named apart because the renderer matches on the family name,
 * and a run of text that finds a glyph in the wrong weight simply uses it.
 * Without either the card still draws, in the renderer's own face.
 */
async function face(weight: 400 | 700, text: string): Promise<ArrayBuffer | null> {
  try {
    const css = await fetch(
      `https://fonts.googleapis.com/css2?family=Archivo:wght@${weight}&text=${encodeURIComponent(text)}`,
      {
        headers: {
          // Google answers with woff2 for a modern browser and truetype for this
          // one, and truetype is what the renderer can read.
          "user-agent": "Mozilla/5.0 (Windows NT 6.1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/33 Safari/537.36",
        },
        signal: AbortSignal.timeout(COUNT_TIMEOUT_MS),
      },
    );
    const source = /src: url\((.+?)\)/.exec(await css.text())?.[1];
    if (source === undefined) {
      return null;
    }
    const file = await fetch(source, { signal: AbortSignal.timeout(COUNT_TIMEOUT_MS) });
    return await file.arrayBuffer();
  } catch {
    return null;
  }
}

/**
 * The stacked lockup exactly as it was drawn. The file is read rather than
 * redrawn here, so the card can never drift from the mark in the header, the
 * tab and the docs. If the read fails the card still draws, with the word set
 * in the display face.
 */
const lockup: Promise<string | null> = readFile(
  new URL("../public/brand/kolam/lockup-stacked-dark.svg", import.meta.url),
)
  .then((file) => `data:image/svg+xml;base64,${file.toString("base64")}`)
  .catch(() => null);

// The file carries clear space of about a sixth of the box above and below the
// artwork. The bleed takes that back so the card is laid out on the ink.
const LOCKUP = { width: 569, height: 380, bleed: -60 };

const KICKER = "LIVE ON MONAD MAINNET";
const LINE = "Every image gets a passport";
const FOOT = "REGISTRY passports registered 0123456789abcdefABCDEFx.";

export default async function Card() {
  const [count, heavy, plain, mark] = await Promise.all([
    passportCount(),
    face(700, "Moolam0123456789"),
    face(400, `${KICKER}${LINE}${FOOT}`),
    lockup,
  ]);

  const display = heavy === null ? "sans-serif" : "ArchivoDisplay";
  const text = plain === null ? "sans-serif" : "ArchivoText";
  const fonts = [
    ...(heavy === null ? [] : [{ name: "ArchivoDisplay", data: heavy, weight: 700 as const, style: "normal" as const }]),
    ...(plain === null ? [] : [{ name: "ArchivoText", data: plain, weight: 400 as const, style: "normal" as const }]),
  ];

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: GROUND,
          backgroundImage: `radial-gradient(120% 90% at 88% 8%, rgba(255,183,197,0.22) 0%, rgba(255,183,197,0.04) 38%, rgba(11,11,12,0) 68%)`,
          padding: "68px 76px",
          position: "relative",
          fontFamily: text,
        }}
      >
        <div style={{ display: "flex", alignItems: "center" }}>
          <div style={{ display: "flex", color: "rgba(245,243,239,0.62)", fontSize: 22, letterSpacing: 6 }}>
            {KICKER}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
          {mark === null ? (
            <div
              style={{
                display: "flex",
                fontFamily: display,
                fontSize: 208,
                fontWeight: 700,
                letterSpacing: -8,
                color: "#F5F3EF",
                lineHeight: 1,
              }}
            >
              Moolam
            </div>
          ) : (
            <img
              src={mark}
              width={LOCKUP.width}
              height={LOCKUP.height}
              alt=""
              style={{ marginTop: LOCKUP.bleed, marginBottom: LOCKUP.bleed, marginLeft: -62 }}
            />
          )}
          <div style={{ display: "flex", marginTop: 22, fontSize: 40, color: "rgba(245,243,239,0.72)" }}>
            {LINE}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
            borderTop: "1px solid rgba(255,255,255,0.14)",
            paddingTop: 28,
          }}
        >
          <div style={{ display: "flex", fontSize: 24, color: "rgba(245,243,239,0.5)", letterSpacing: 3 }}>
            {`REGISTRY ${addresses.registry.slice(0, 10)}...${addresses.registry.slice(-6)}`}
          </div>
          {count !== null && (
            <div style={{ display: "flex", alignItems: "flex-end", gap: 16 }}>
              <div
                style={{
                  display: "flex",
                  fontFamily: display,
                  fontSize: 92,
                  fontWeight: 700,
                  letterSpacing: -3,
                  color: ACCENT,
                  lineHeight: 1,
                }}
              >
                {count.toString()}
              </div>
              <div style={{ display: "flex", paddingBottom: 10, fontSize: 26, color: "rgba(245,243,239,0.5)" }}>
                passports registered
              </div>
            </div>
          )}
        </div>
      </div>
    ),
    { ...size, fonts: fonts.length === 0 ? undefined : fonts, headers: CARD_HEADERS },
  );
}
