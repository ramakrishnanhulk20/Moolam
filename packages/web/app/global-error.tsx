"use client";

/**
 * The last page there is: the one Next shows when the layout above every other
 * page is the thing that broke.
 *
 * It carries its own html and body the way app/not-found.tsx does, because at
 * this point no layout of ours is rendering. It is English only and imports
 * nothing but the stylesheet: a translation file, a font module or a link
 * helper are three more things that could be the very thing that failed. The
 * error's own message and stack are never printed.
 */
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      {/* Light, the theme every visitor starts in. The theme's own hex values
          are written out, because no stylesheet variable can be trusted here. */}
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          gap: "1.5rem",
          padding: "6rem 1.25rem",
          background: "#e4ddd0",
          color: "#14130f",
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
        }}
      >
        <p style={{ margin: 0, fontSize: "0.7rem", letterSpacing: "0.28em", textTransform: "uppercase", opacity: 0.5 }}>
          Moolam
        </p>
        <h1 style={{ margin: 0, maxWidth: "14ch", fontSize: "clamp(2.2rem, 8vw, 4.5rem)", lineHeight: 0.9 }}>
          Something broke
        </h1>
        <p style={{ margin: 0, maxWidth: "46ch", fontSize: "1rem", lineHeight: 1.6, opacity: 0.75 }}>
          This page could not be shown. Nothing on Monad is affected: every passport is still in the registry. Try
          again, or start from the home page.
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem" }}>
          <button
            type="button"
            onClick={reset}
            style={{
              cursor: "pointer",
              borderRadius: 8,
              border: "none",
              background: "#a52946",
              color: "#fff5f7",
              padding: "0.85rem 1.4rem",
              fontSize: "0.7rem",
              fontWeight: 600,
              letterSpacing: "0.16em",
              textTransform: "uppercase",
            }}
          >
            Try again
          </button>
          {/* A plain link on purpose, and the one rule this file breaks: the
              app around this page is the thing that failed, so the way out is a
              fresh load of the home page rather than a move inside it. */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a
            href="/en"
            style={{
              borderRadius: 8,
              border: "1px solid #aba08b",
              color: "#14130f",
              padding: "0.85rem 1.4rem",
              fontSize: "0.7rem",
              fontWeight: 600,
              letterSpacing: "0.16em",
              textTransform: "uppercase",
              textDecoration: "none",
            }}
          >
            Home
          </a>
        </div>
      </body>
    </html>
  );
}
