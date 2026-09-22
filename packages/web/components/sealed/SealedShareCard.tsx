import { SealedSketch, type SketchDrawing } from "./Sketch";

/**
 * The card a sealed passport's link carries into a chat, drawn at its real size
 * of 1200 by 630.
 *
 * The colours are written out rather than taken from the theme because a social
 * card has no theme: it is one picture on a dark ground wherever it is pasted.
 * They are the same three values the passport card route already draws with.
 */
const GROUND = "#0B0B0C";
const PAPER = "#F5F3EF";
const ACCENT = "#FFB7C5";
const WIDTH = 1200;
const HEIGHT = 630;
const SKETCH_PANEL = 660;

export interface SealedShareCardWords {
  sealed: string;
  /** "Sealed on Monad, 14 Sep 2026. The picture is not published." */
  line: string;
  untitled: string;
}

/**
 * The link preview for a passport with no picture in it.
 *
 * Where a published passport puts the registered picture, this puts the block
 * hash, so a link that spreads says what the record is instead of showing a
 * grey rectangle. It is a plain component: no motion, nothing measured in the
 * browser, so the same markup can be drawn by the card route later.
 */
export function SealedShareCard({
  bits,
  title,
  shortId,
  words,
  drawing = "grid",
}: {
  bits: boolean[];
  title: string | null;
  shortId: string;
  words: SealedShareCardWords;
  drawing?: SketchDrawing;
}) {
  const named = title === null || title.trim().length === 0 ? words.untitled : title;
  const titleSize = named.length <= 18 ? 84 : named.length <= 30 ? 66 : 52;

  return (
    <div
      className="dark relative overflow-hidden"
      style={{ width: WIDTH, height: HEIGHT, background: GROUND, color: PAPER }}
    >
      <div className="absolute inset-y-0 start-0" style={{ width: SKETCH_PANEL }}>
        <div
          className="absolute"
          style={{
            inset: 0,
            backgroundImage: "radial-gradient(70% 60% at 50% 45%, rgba(255,183,197,0.18) 0%, rgba(11,11,12,0) 70%)",
          }}
        />
        {/* High enough in the panel that the title below it lands on the ground
            rather than on the cells, which is where a photograph would be too. */}
        <div className="absolute" style={{ left: 150, top: 104, width: 280, height: 280 }}>
          <SealedSketch bits={bits} drawing={drawing} size="poster" still className="h-full w-full" />
        </div>
      </div>

      <div
        className="absolute inset-y-0"
        style={{
          left: SKETCH_PANEL - 190,
          width: 190,
          backgroundImage: `linear-gradient(to right, rgba(11,11,12,0) 0%, ${GROUND} 100%)`,
        }}
      />
      <div
        className="absolute inset-0"
        style={{
          backgroundImage:
            "radial-gradient(58% 70% at 96% 4%, rgba(255,183,197,0.26) 0%, rgba(255,183,197,0.05) 40%, rgba(11,11,12,0) 72%)",
        }}
      />
      <div
        className="absolute inset-x-0 bottom-0"
        style={{
          height: 240,
          backgroundImage:
            "linear-gradient(to top, rgba(11,11,12,0.97) 0%, rgba(11,11,12,0.78) 46%, rgba(11,11,12,0) 100%)",
        }}
      />

      <div className="absolute flex items-center" style={{ top: 48, left: 56, gap: 18 }}>
        <span className="motif" style={{ width: 34, height: 34 }} />
        <span className="font-mono" style={{ fontSize: 21, letterSpacing: 4, color: "rgba(245,243,239,0.74)" }}>
          {shortId}
        </span>
        <span style={{ width: 1, height: 22, background: "rgba(245,243,239,0.28)" }} />
        <span
          className="font-mono uppercase"
          style={{ fontSize: 21, letterSpacing: 6, color: ACCENT }}
        >
          {words.sealed}
        </span>
      </div>

      <div className="absolute flex flex-col" style={{ bottom: 54, left: 56, width: 760 }}>
        <span
          className="font-display font-bold"
          style={{ fontSize: titleSize, letterSpacing: -2, lineHeight: 1, color: PAPER }}
        >
          {named}
        </span>
        <span className="font-mono" style={{ marginTop: 22, fontSize: 24, letterSpacing: 1, color: ACCENT }}>
          {words.line}
        </span>
      </div>

      {/* The wordmark is one flat shape, so it is drawn as a mask filled with
          the accent rather than as a second recoloured copy of the brand file. */}
      <span
        className="absolute"
        style={{
          bottom: 52,
          right: 48,
          width: 238,
          height: 94,
          background: ACCENT,
          maskImage: "url(/brand/seal-o/lockup-horizontal-dark.svg)",
          WebkitMaskImage: "url(/brand/seal-o/lockup-horizontal-dark.svg)",
          maskSize: "contain",
          WebkitMaskSize: "contain",
          maskRepeat: "no-repeat",
          WebkitMaskRepeat: "no-repeat",
          maskPosition: "center",
          WebkitMaskPosition: "center",
        }}
      />
    </div>
  );
}
