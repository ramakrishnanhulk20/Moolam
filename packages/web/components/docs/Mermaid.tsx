"use client";

import { useTheme } from "next-themes";
import { useTranslations } from "next-intl";
import { useEffect, useId, useState, useSyncExternalStore } from "react";
import { DiagramFrame } from "./DiagramFrame";
import type { DiagramVariant } from "@/lib/docs/render";

/** The app's own palette, handed to mermaid so a diagram belongs to the page. */
const palettes = {
  dark: {
    background: "#08080a",
    mainBkg: "#101014",
    primaryColor: "#101014",
    primaryTextColor: "#f4f2ee",
    primaryBorderColor: "#ffb7c5",
    secondaryColor: "#16161c",
    tertiaryColor: "#0d0d11",
    lineColor: "#6a6975",
    textColor: "#f4f2ee",
    nodeBorder: "#34343f",
    clusterBkg: "#0c0c10",
    clusterBorder: "#23232b",
    titleColor: "#ffb7c5",
    edgeLabelBackground: "#08080a",
    actorBkg: "#101014",
    actorBorder: "#ffb7c5",
    actorTextColor: "#f4f2ee",
    actorLineColor: "#34343f",
    signalColor: "#9a99a4",
    signalTextColor: "#f4f2ee",
    labelBoxBkgColor: "#101014",
    labelBoxBorderColor: "#34343f",
    labelTextColor: "#f4f2ee",
    loopTextColor: "#f4f2ee",
    noteBkgColor: "#16161c",
    noteBorderColor: "#34343f",
    noteTextColor: "#f4f2ee",
    sequenceNumberColor: "#0b0b0c",
  },
  // Linen, as the light block in globals.css paints it. Mermaid bakes hex into
  // the drawing, so it cannot read the tokens. The lines are a step darker than
  // on the old paper to keep 3:1 on the cluster ground.
  light: {
    background: "#e4ddd0",
    mainBkg: "#ede7dc",
    primaryColor: "#ede7dc",
    primaryTextColor: "#14130f",
    primaryBorderColor: "#a52946",
    secondaryColor: "#dfd8ca",
    tertiaryColor: "#d8d0c1",
    lineColor: "#78746e",
    textColor: "#14130f",
    nodeBorder: "#aba08b",
    clusterBkg: "#dbd3c4",
    clusterBorder: "#c9c0b0",
    titleColor: "#a52946",
    edgeLabelBackground: "#e4ddd0",
    actorBkg: "#ede7dc",
    actorBorder: "#a52946",
    actorTextColor: "#14130f",
    actorLineColor: "#aba08b",
    signalColor: "#56534b",
    signalTextColor: "#14130f",
    labelBoxBkgColor: "#ede7dc",
    labelBoxBorderColor: "#aba08b",
    labelTextColor: "#14130f",
    loopTextColor: "#14130f",
    noteBkgColor: "#dfd8ca",
    noteBorderColor: "#aba08b",
    noteTextColor: "#14130f",
    sequenceNumberColor: "#fff5f7",
  },
} as const;

/** The width below which a wide drawing gives way to its phone redraw. */
const narrowQuery = "(max-width: 767px)";

function watchWidth(fire: () => void): () => void {
  const query = window.matchMedia(narrowQuery);
  query.addEventListener("change", fire);
  return () => query.removeEventListener("change", fire);
}

/**
 * True on a phone. Read through the store hook rather than an effect, so the
 * first client render already knows the width and mermaid is never asked to
 * draw a picture that is about to be hidden.
 */
function useNarrow(): boolean {
  return useSyncExternalStore(
    watchWidth,
    () => window.matchMedia(narrowQuery).matches,
    () => false,
  );
}

/**
 * The three architecture drawings, drawn in the browser.
 *
 * Mermaid is a megabyte of layout engine, so it is only fetched on a page that
 * has a diagram on it, and never on the server. The drawing is made again when
 * the theme changes, because its colours are baked into the SVG.
 */
export function Mermaid({
  chart,
  variant = "both",
  caption = null,
  height = null,
}: {
  chart: string;
  variant?: DiagramVariant;
  caption?: string | null;
  /** The finished frame's height from the fence, held while mermaid draws. */
  height?: number | null;
}) {
  const t = useTranslations("docs");
  const { resolvedTheme } = useTheme();
  const narrow = useNarrow();
  const showing = variant === "both" || variant === (narrow ? "phone" : "wide");
  const raw = useId();
  const id = `mermaid-${raw.replace(/[^a-zA-Z0-9]/g, "")}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!showing) {
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          // Strict is mermaid's own sanitiser: a label cannot carry a script or
          // a link out of the page.
          securityLevel: "strict",
          theme: "base",
          themeVariables: {
            ...palettes[resolvedTheme === "light" ? "light" : "dark"],
            fontFamily: "var(--font-body), Inter, sans-serif",
            fontSize: "14px",
          },
          // useMaxWidth is mermaid's own squeeze: it sets the drawing to the
          // width of the column, which would turn a 2,700 px flowchart into 4 px
          // labels. So a wide drawing keeps its natural size and the frame
          // around it scrolls. A phone redraw is small enough that fitting it to
          // the column costs almost nothing, and in return the frame under it
          // never scrolls sideways at all.
          // A phone redraw is also drawn tighter: the space between two boxes is
          // what pushes a drawing past the width of a phone, and every pixel of
          // it saved is a pixel the labels keep.
          flowchart:
            variant === "phone"
              ? { curve: "basis", htmlLabels: true, padding: 8, nodeSpacing: 18, rankSpacing: 34, useMaxWidth: true }
              : { curve: "basis", htmlLabels: true, padding: 16, useMaxWidth: false },
          sequence: { useMaxWidth: false, mirrorActors: false },
        });
        const drawn = await mermaid.render(id, chart);
        if (alive) {
          setSvg(drawn.svg);
        }
      } catch {
        if (alive) {
          setFailed(true);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [chart, id, resolvedTheme, showing, variant]);

  if (!showing) {
    return null;
  }

  if (failed) {
    // Better an honest listing of the drawing's source than an empty frame.
    return (
      <div className="docs-code">
        <pre>
          <code>{chart}</code>
        </pre>
      </div>
    );
  }

  if (svg === null) {
    return (
      <figure
        className="docs-diagram docs-diagram-held"
        data-variant={variant}
        aria-busy
        style={height === null ? undefined : { height: `${height}px` }}
      >
        <span className="docs-diagram-wait">{t("diagram")}</span>
      </figure>
    );
  }

  return <DiagramFrame svg={svg} variant={variant} caption={caption} />;
}
