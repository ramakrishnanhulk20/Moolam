// The card is drawn by satori, which knows img and nothing else. next/image
// cannot be used inside an ImageResponse, so the rule that asks for it is off
// for this file only.
/* eslint-disable @next/next/no-img-element */
import { readFile } from "node:fs/promises";
import type { Metadata } from "next";
import { unstable_cache } from "next/cache";
import { ImageResponse } from "next/og";
import type { Hex } from "viem";
import { readArt, type Art } from "@/components/passport/art";
import { withUnseal } from "@/lib/data/unseal";
import { sealedBits } from "@/components/passport/sealed";
import { SKETCH_SIDE } from "@/components/sealed/bits";
import { shortHex } from "@/lib/chain/client";
import { getPassport } from "@/lib/chain/registry";
import { passportRegistration } from "@/lib/data/passports";

/**
 * The social card for one passport: the registered picture, the seal, the title
 * and the block it was written in.
 *
 * A link to a record is the thing people paste into a chat, so the card has to
 * be the record itself rather than the app's generic poster. Everything on it is
 * read live when the card is drawn. An id nobody registered, or any read that
 * fails, falls back to the app's own card, because a crawler that gets a 500
 * shows the link with no picture at all.
 */

export const alt = "A Moolam passport: the registered picture, its seal and the block it was written in";
export const size = { width: 1200, height: 630 };
export const contentType = "image/jpeg";

// The brand files are read from disk and the faces are fetched, which is a node
// job. The drawn card is then held for an hour: an unfurl in a chat has to come
// back inside a second, and a passport's picture, title and block do not change
// once it is registered. The header is what the cache in front of this route
// reads; the segment setting is for the times Next can hold the picture itself.
export const runtime = "nodejs";
export const revalidate = 3600;

const CARD_HEADERS = { "cache-control": "public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400" };

const ACCENT = "#FFB7C5";
const GROUND = "#0B0B0C";
const PAPER = "#F5F3EF";
const PICTURE_WIDTH = 660;
const FETCH_TIMEOUT_MS = 6_000;
const ID_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/** Longer than this and the title stops being a poster line, so it is cut. */
const TITLE_LIMIT = 44;

/**
 * How long a description may be before a search result and a link preview start
 * cutting it themselves, which they do mid-word.
 */
const DESCRIPTION_LIMIT = 160;

/**
 * The description, cut at a whole word.
 *
 * A passport's line leads with what the holder said about AI use and then
 * carries whatever was pinned with the picture, which together ran to 297
 * characters on the two records the launch audit measured. The lead is the part
 * that matters, so the tail is what goes.
 */
export function shortDescription(text: string, limit = DESCRIPTION_LIMIT): string {
  const line = text.trim().replace(/\s+/g, " ");
  if (line.length <= limit) {
    return line;
  }
  // Three dots are part of the count, so the words stop three characters early
  // and the whole line still fits the budget.
  const window = line.slice(0, limit - 3);
  const lastSpace = window.lastIndexOf(" ");
  const kept = lastSpace > limit / 2 ? window.slice(0, lastSpace) : window;
  return `${kept.replace(/[\s,;:.-]+$/u, "")}...`;
}

/** What the card and the page head call a passport that pinned no name. */
export function cardTitle(title: string | undefined, id: string): string {
  const named = title === undefined ? "" : title.trim();
  if (named.length === 0) {
    return `Passport ${shortHex(id, 6, 4)}`;
  }
  return named.length > TITLE_LIMIT ? `${named.slice(0, TITLE_LIMIT - 3).trimEnd()}...` : named;
}

/**
 * The line under the title. The block comes from the index; when the index has
 * not caught up with this record the chain's own registration time stands in,
 * because "registered, and we will not say where" is not worth printing.
 */
export function registeredLine(block: bigint | null, registeredAt: bigint | null): string {
  return `Registered on Monad${where(block, registeredAt)}`;
}

/**
 * The same line for a passport whose picture was never published.
 *
 * The card says sealed in the corner and again here, because a link preview is
 * often the whole of what anybody sees and a card with no picture on it must
 * not read as a card that failed to load one.
 */
export function sealedLine(block: bigint | null, registeredAt: bigint | null): string {
  return `Sealed on Monad${where(block, registeredAt)}`;
}

/** The block if the index has it, the chain's own timestamp if it does not, nothing if neither. */
function where(block: bigint | null, registeredAt: bigint | null): string {
  if (block !== null) {
    return `, block ${block.toLocaleString("en-US")}`;
  }
  if (registeredAt !== null) {
    const when = new Intl.DateTimeFormat("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(Number(registeredAt) * 1000));
    return `, ${when}`;
  }
  return "";
}

/**
 * What the passport page puts in its head. It lives here beside the card so the
 * title on the picture and the title in the link preview can never drift apart.
 */
export function passportShareMetadata(input: {
  locale: string;
  id: string;
  title?: string;
  description?: string;
  fallbackDescription: string;
}): Metadata {
  const heading = `${cardTitle(input.title, input.id)} on Moolam`;
  const said = input.description?.trim();
  const description = shortDescription(
    said === undefined || said.length === 0 ? input.fallbackDescription : said,
  );
  const base = `/${input.locale}/passport/${input.id}`;

  return {
    // The heading already names Moolam, so the brand is not added twice.
    title: { absolute: heading },
    description,
    openGraph: {
      title: heading,
      description,
      type: "article",
      images: [{ url: `${base}/opengraph-image`, width: size.width, height: size.height, alt: heading }],
    },
    twitter: {
      card: "summary_large_image",
      title: heading,
      description,
      images: [`${base}/twitter-image`],
    },
  };
}

/**
 * The card's faces, subset to the glyphs it sets. next/font packs these for the
 * browser, which the image renderer cannot read, so the same families are
 * fetched here. Without either the card still draws, in the renderer's own face.
 */
async function face(family: string, weight: number, text: string): Promise<ArrayBuffer | null> {
  try {
    const css = await fetch(
      `https://fonts.googleapis.com/css2?family=${family}:wght@${weight}&text=${encodeURIComponent(text)}`,
      {
        headers: {
          // Google answers with woff2 for a modern browser and truetype for this
          // one, and truetype is what the renderer can read.
          "user-agent":
            "Mozilla/5.0 (Windows NT 6.1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/33 Safari/537.36",
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      },
    );
    const source = /src: url\((.+?)\)/.exec(await css.text())?.[1];
    if (source === undefined) {
      return null;
    }
    const file = await fetch(source, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    return await file.arrayBuffer();
  } catch {
    return null;
  }
}

const seal: Promise<string | null> = readFile(
  new URL("../../../../public/brand/seal-o/mark-dark.svg", import.meta.url),
)
  .then((file) => `data:image/svg+xml;base64,${file.toString("base64")}`)
  .catch(() => null);

// The lockup is drawn with paper coloured letters for a dark header. On the card
// the whole wordmark sits in the accent, so the letters are recoloured inside
// the brand file rather than a second mark being drawn by hand here.
const wordmark: Promise<string | null> = readFile(
  new URL("../../../../public/brand/seal-o/lockup-horizontal-dark.svg", import.meta.url),
)
  .then((file) => file.toString("utf8").split('fill="#F5F1EA"').join(`fill="${ACCENT}"`))
  .then((file) => `data:image/svg+xml;base64,${Buffer.from(file, "utf8").toString("base64")}`)
  .catch(() => null);

/**
 * The pinned picture as bytes the renderer can draw.
 *
 * The pinned 512 px thumbnail is what gets drawn: it is the same picture, it is
 * a tenth of the bytes, and every pixel of the full image would land in the card
 * as PNG that a crawler has to carry. The full image is a last resort for a
 * record that pinned no thumbnail. Only the two formats the renderer decodes are
 * accepted, so anything else is treated as a picture that did not arrive and the
 * card falls back to the seal rather than drawing an empty rectangle.
 */
async function picture(id: Hex, art: Art): Promise<string | null> {
  const url = art.thumbnailUrl ?? art.imageUrl;
  if (url === undefined || !url.startsWith("http")) {
    return null;
  }

  return await heldPicture(id, url);
}

/**
 * The drawn bytes, held for a day under the passport's own id.
 *
 * A link that spreads is unfurled by every chat app that sees it, and each
 * unfurl used to be one more read of the IPFS gateway for the same picture of
 * the same record. The picture is content addressed and the record cannot grow
 * a different one, so a day is safe.
 */
// The id is in the signature because unstable_cache keys on the arguments: it
// is what makes one held answer per passport rather than one for the route.
const heldPicture = unstable_cache(async (id: Hex, url: string) => await fetchPicture(url), ["moolam-card-picture"], {
  revalidate: 86_400,
});

async function fetchPicture(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), cache: "no-store" });
    if (!response.ok) {
      return null;
    }
    const type = (response.headers.get("content-type") ?? "").split(";")[0].trim();
    if (type !== "image/png" && type !== "image/jpeg" && type !== "image/jpg") {
      return null;
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    return `data:${type};base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}

/** The block the index says this record was written in, or null when it cannot say. */
async function indexedBlock(id: Hex): Promise<bigint | null> {
  try {
    return (await passportRegistration(id))?.registeredBlock ?? null;
  } catch {
    return null;
  }
}

/** The app's own card, for an id nobody registered and for any read that fails. */
async function genericCard(): Promise<ImageResponse> {
  const { default: appCard } = await import("@/app/opengraph-image");
  return await appCard();
}

/** The sentence under a sealed card's line, so a reader is told what they are not seeing. */
const SEALED_NOTE = "The picture is not published.";

/** What the word in the corner of a sealed card says. */
const SEALED_WORD = "SEALED";

interface Card {
  title: string;
  line: string;
  short: string;
  /**
   * The 256 bits of the block hash, drawn where the picture would be on a
   * sealed record, or an empty list on a published one.
   */
  bits: boolean[];
  /** The pinned picture as a data URL, or null when the gateway did not hand it over. */
  still: string | null;
  mark: string | null;
  word: string | null;
  display: string;
  mono: string;
  titleSize: number;
}

type Face = { name: string; data: ArrayBuffer; weight: 400 | 700; style: "normal" };

/**
 * Everything the card draws, or null when this id has no record and for any
 * read that threw. The caller then falls back to the app's own card.
 */
async function readCard(params: Promise<{ locale: string; id: string }>): Promise<{ card: Card; fonts: Face[] } | null> {
  try {
    const { id } = await params;
    const passport = ID_PATTERN.test(id) ? await getPassport(id as Hex) : null;
    if (passport === null) {
      return null;
    }

    const [art, block] = await Promise.all([
      // The record beside the document is what says a sealed passport has been
      // published since, so the card draws the picture rather than the seal for
      // a link somebody shares after unsealing.
      readArt(passport.metadataURI).then(async (document) => await withUnseal(document, passport.id)),
      indexedBlock(passport.id),
    ]);
    const sealed = art.sealed === true;
    const title = cardTitle(art.title, passport.id);
    const line = sealed ? sealedLine(block, passport.registeredAt) : registeredLine(block, passport.registeredAt);
    const short = shortHex(passport.id, 10, 8);

    const [still, mark, word, heavy, plain] = await Promise.all([
      // A sealed record has nothing pinned to fetch, and asking the gateway for
      // a picture that was never published is how a card ends up with a hole
      // in it while the request times out.
      sealed ? null : picture(passport.id, art),
      seal,
      wordmark,
      face("Archivo", 700, title),
      face("IBM+Plex+Mono", 400, `${line}${short}${SEALED_NOTE}${SEALED_WORD}`),
    ]);

    const fonts: Face[] = [
      ...(heavy === null ? [] : [{ name: "ArchivoDisplay", data: heavy, weight: 700 as const, style: "normal" as const }]),
      ...(plain === null ? [] : [{ name: "PlexMono", data: plain, weight: 400 as const, style: "normal" as const }]),
    ];

    return {
      card: {
        title,
        line,
        short,
        bits: sealed ? sealedBits(passport.blockhash256, art.blockhash) : [],
        still,
        mark,
        word,
        display: heavy === null ? "sans-serif" : "ArchivoDisplay",
        mono: plain === null ? "monospace" : "PlexMono",
        // A long title takes a smaller face rather than a second line, so the
        // card reads the same way at thumbnail size whatever was pinned.
        titleSize: title.length <= 18 ? 84 : title.length <= 30 ? 66 : 52,
      },
      fonts,
    };
  } catch {
    return null;
  }
}

/**
 * The block hash drawn in the renderer's own language.
 *
 * The component the pages use is written in Tailwind classes, which satori
 * cannot read, so the same 16 by 16 grid is laid out here in plain boxes. The
 * cell and the gap are whole pixels: the picture is drawn once at a fixed size,
 * and a fractional cell is where a grid picks up a seam.
 */
const SKETCH_BOX = 280;
const SKETCH_GAP = 2;
const SKETCH_CELL = (SKETCH_BOX - SKETCH_GAP * (SKETCH_SIDE - 1)) / SKETCH_SIDE;

function Sketch({ bits }: { bits: boolean[] }) {
  const rows = Array.from({ length: SKETCH_SIDE }, (_, row) => bits.slice(row * SKETCH_SIDE, (row + 1) * SKETCH_SIDE));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: SKETCH_GAP }}>
      {rows.map((row, at) => (
        <div key={at} style={{ display: "flex", gap: SKETCH_GAP }}>
          {row.map((lit, column) => (
            <div
              key={column}
              style={{
                display: "flex",
                width: SKETCH_CELL,
                height: SKETCH_CELL,
                background: lit ? PAPER : "rgba(245,243,239,0.07)",
              }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function CardFace({ card }: { card: Card }) {
  const { title, line, short, bits, still, mark, word, display, mono, titleSize } = card;
  const sealed = bits.length > 0;

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        position: "relative",
        background: GROUND,
        fontFamily: mono,
      }}
    >
      {still === null ? (
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: PICTURE_WIDTH,
            height: size.height,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            backgroundImage:
              "radial-gradient(70% 60% at 50% 45%, rgba(255,183,197,0.16) 0%, rgba(11,11,12,0) 70%)",
          }}
        >
          {/* A sealed record puts its fingerprint where the picture would be.
              Everything else that has no picture keeps the seal. */}
          {sealed ? (
            <div style={{ display: "flex", marginTop: -96 }}>
              <Sketch bits={bits} />
            </div>
          ) : mark === null ? null : (
            <img src={mark} width={220} height={220} alt="" style={{ opacity: 0.5 }} />
          )}
        </div>
      ) : (
        <img
          src={still}
          width={PICTURE_WIDTH}
          height={size.height}
          alt=""
          style={{ position: "absolute", top: 0, left: 0, objectFit: "cover" }}
        />
      )}

      <div
        style={{
          position: "absolute",
          top: 0,
          left: PICTURE_WIDTH - 190,
          width: 190,
          height: size.height,
          display: "flex",
          backgroundImage: `linear-gradient(to right, rgba(11,11,12,0) 0%, ${GROUND} 100%)`,
        }}
      />

      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: size.width,
          height: size.height,
          display: "flex",
          backgroundImage:
            "radial-gradient(58% 70% at 96% 4%, rgba(255,183,197,0.26) 0%, rgba(255,183,197,0.05) 40%, rgba(11,11,12,0) 72%)",
        }}
      />

      <div
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          width: size.width,
          height: 240,
          display: "flex",
          backgroundImage:
            "linear-gradient(to top, rgba(11,11,12,0.97) 0%, rgba(11,11,12,0.78) 46%, rgba(11,11,12,0) 100%)",
        }}
      />

      <div style={{ position: "absolute", top: 48, left: 56, display: "flex", alignItems: "center", gap: 18 }}>
        {mark === null ? null : <img src={mark} width={34} height={34} alt="" />}
        <div style={{ display: "flex", fontSize: 21, letterSpacing: 4, color: "rgba(245,243,239,0.74)" }}>
          {short}
        </div>
        {sealed ? (
          <>
            <div style={{ display: "flex", width: 1, height: 22, background: "rgba(245,243,239,0.28)" }} />
            <div style={{ display: "flex", fontSize: 21, letterSpacing: 6, color: ACCENT }}>{SEALED_WORD}</div>
          </>
        ) : null}
      </div>

      <div
        style={{
          position: "absolute",
          bottom: 54,
          left: 56,
          width: 720,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            display: "flex",
            fontFamily: display,
            fontWeight: 700,
            fontSize: titleSize,
            letterSpacing: -2,
            lineHeight: 1,
            color: PAPER,
          }}
        >
          {title}
        </div>
        <div style={{ display: "flex", marginTop: 22, fontSize: 24, letterSpacing: 2, color: ACCENT }}>{line}</div>
        {sealed ? (
          <div
            style={{ display: "flex", marginTop: 10, fontSize: 22, letterSpacing: 1, color: "rgba(245,243,239,0.76)" }}
          >
            {SEALED_NOTE}
          </div>
        ) : null}
      </div>

      {word === null ? null : (
        <img src={word} width={238} height={94} alt="" style={{ position: "absolute", bottom: 52, right: 48 }} />
      )}
    </div>
  );
}

/**
 * High enough that the seal, the hairlines and the small mono line come through
 * without a JPEG edge on them, which is what a lower number costs on a card
 * that is mostly type over a photograph.
 */
const JPEG_QUALITY = 92;

/**
 * The drawn card as JPEG.
 *
 * The renderer only writes PNG, and a PNG of a 660 px photograph came out at
 * 606 KB and 714 KB for the two records the launch audit measured. Several chat
 * apps stop fetching a preview around 300 KB, so a shared passport arrived
 * there as a bare link. The same face as JPEG is about a seventh of that.
 *
 * The encoder ships with Next as an optional package and is external to the
 * server bundle, so it is asked for at the moment it is needed and a host that
 * does not have it hands back the PNG exactly as before rather than no card.
 */
async function asJpeg(drawn: ImageResponse): Promise<Response> {
  const png = Buffer.from(await drawn.arrayBuffer());
  try {
    const { default: sharp } = await import("sharp");
    const jpeg = await sharp(png)
      // Full colour rather than the usual halved chroma: the accent pink of the
      // seal and the rule sits on near black, which is where halved chroma
      // smears.
      .jpeg({ quality: JPEG_QUALITY, chromaSubsampling: "4:4:4", mozjpeg: true })
      .toBuffer();
    return new Response(new Uint8Array(jpeg), { headers: { ...CARD_HEADERS, "content-type": "image/jpeg" } });
  } catch {
    return new Response(new Uint8Array(png), { headers: { ...CARD_HEADERS, "content-type": "image/png" } });
  }
}

export default async function PassportCard({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}): Promise<Response> {
  const drawn = await readCard(params);
  if (drawn === null) {
    return await asJpeg(await genericCard());
  }

  return await asJpeg(
    new ImageResponse(<CardFace card={drawn.card} />, {
      ...size,
      fonts: drawn.fonts.length === 0 ? undefined : drawn.fonts,
    }),
  );
}
