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

/**
 * The Linen room's colours, the light site's own tokens, which both share cards
 * draw with. Every text colour clears 4.5:1 on the ground: ink 13.7, muted 5.6,
 * faint 4.6, crimson 5.1.
 */
export const LINEN = {
  ground: "#e4ddd0",
  paper: "#f1ece3",
  ink: "#14130f",
  muted: "#56534b",
  faint: "#63605a",
  crimson: "#a52946",
  // The room's shadow colour as channels, so it can carry its own opacity.
  shadow: "58,51,38",
} as const;

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
    // A text with no glyph in the family (a title written only in Chinese, for
    // one) gets an HTML error page here, and the renderer throws on it as a
    // font, which turned the whole card into a 500. No face is the safe answer.
    if (!file.ok) {
      return null;
    }
    return await file.arrayBuffer();
  } catch {
    return null;
  }
}

/**
 * A light brand file as a data URL, in the Linen room's own ink and crimson.
 *
 * The file is read rather than redrawn, so a card can never drift from the mark
 * in the header, the tab and the docs. The light files carry an older pair
 * (#0B0B0C letters, #A92A48 kolam), so the two are swapped for the site's tokens
 * inside the file. A failed read gives null and the card draws without it.
 * Each caller names its file in full: the bundler resolves the path at build
 * time, and a path pieced together from a variable resolves to one file for all.
 */
export function lightBrand(file: URL): Promise<string | null> {
  return readFile(file)
    .then((bytes) =>
      bytes
        .toString("utf8")
        .split('"#0B0B0C"')
        .join(`"${LINEN.ink}"`)
        .split('"#A92A48"')
        .join(`"${LINEN.crimson}"`),
    )
    .then((svg) => `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`)
    .catch(() => null);
}

/** The stacked lockup. If the read fails the card still draws, with the word set in the display face. */
const lockup = lightBrand(new URL("../public/brand/kolam/lockup-stacked-light.svg", import.meta.url));

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
          background: LINEN.ground,
          padding: "68px 76px",
          position: "relative",
          fontFamily: text,
        }}
      >
        <div style={{ display: "flex", alignItems: "center" }}>
          <div style={{ display: "flex", color: LINEN.faint, fontSize: 22, letterSpacing: 6 }}>
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
                color: LINEN.ink,
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
          <div style={{ display: "flex", marginTop: 22, fontSize: 40, color: LINEN.muted }}>
            {LINE}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
            borderTop: "1px solid rgba(20,19,15,0.16)",
            paddingTop: 28,
          }}
        >
          <div style={{ display: "flex", fontSize: 24, color: LINEN.faint, letterSpacing: 3 }}>
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
                  color: LINEN.crimson,
                  lineHeight: 1,
                }}
              >
                {count.toString()}
              </div>
              <div style={{ display: "flex", paddingBottom: 10, fontSize: 26, color: LINEN.faint }}>
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
