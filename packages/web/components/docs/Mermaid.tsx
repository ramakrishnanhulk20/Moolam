"use client";

import { useTheme } from "next-themes";
import { useTranslations } from "next-intl";
import { useEffect, useId, useState } from "react";
import { DiagramFrame } from "./DiagramFrame";

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
  light: {
    background: "#f2efe9",
    mainBkg: "#fbf9f5",
    primaryColor: "#fbf9f5",
    primaryTextColor: "#14130f",
    primaryBorderColor: "#a92a48",
    secondaryColor: "#efeae1",
    tertiaryColor: "#e6e2da",
    lineColor: "#7c7871",
    textColor: "#14130f",
    nodeBorder: "#b9b2a3",
    clusterBkg: "#eae5dc",
    clusterBorder: "#d6d1c6",
    titleColor: "#a92a48",
    edgeLabelBackground: "#f2efe9",
    actorBkg: "#fbf9f5",
    actorBorder: "#a92a48",
    actorTextColor: "#14130f",
    actorLineColor: "#b9b2a3",
    signalColor: "#56534b",
    signalTextColor: "#14130f",
    labelBoxBkgColor: "#fbf9f5",
    labelBoxBorderColor: "#b9b2a3",
    labelTextColor: "#14130f",
    loopTextColor: "#14130f",
    noteBkgColor: "#efeae1",
    noteBorderColor: "#b9b2a3",
    noteTextColor: "#14130f",
    sequenceNumberColor: "#fff5f7",
  },
} as const;

/**
 * The three architecture drawings, drawn in the browser.
 *
 * Mermaid is a megabyte of layout engine, so it is only fetched on a page that
 * has a diagram on it, and never on the server. The drawing is made again when
 * the theme changes, because its colours are baked into the SVG.
 */
export function Mermaid({ chart }: { chart: string }) {
  const t = useTranslations("docs");
  const { resolvedTheme } = useTheme();
  const raw = useId();
  const id = `mermaid-${raw.replace(/[^a-zA-Z0-9]/g, "")}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
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
          // useMaxWidth is mermaid's own squeeze: it would set the drawing to
          // the width of the column, which turns a 2,700 px flowchart into 4 px
          // labels. The drawings keep their natural size and the frame around
          // them scrolls instead.
          flowchart: { curve: "basis", htmlLabels: true, padding: 16, useMaxWidth: false },
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
  }, [chart, id, resolvedTheme]);

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
      <figure className="docs-diagram" aria-busy>
        <span className="docs-diagram-wait">{t("diagram")}</span>
      </figure>
    );
  }

  return <DiagramFrame svg={svg} />;
}
