"use client";

import dynamic from "next/dynamic";

// The shape next/font hands back. Taken from one of the five modules so this
// file never reaches into a Next internal path for a type.
type Face = Awaited<typeof import("@/lib/fonts/script/ta")>["face"];

/**
 * The one non-Latin face the page being read needs, and nothing else.
 *
 * next/font puts its stylesheet wherever the face is imported, and all ten
 * languages share a single Next route, so importing the five script faces in
 * the layout shipped all five to every reader: about 100 KB gzipped of
 * render-blocking CSS on an English page for glyphs it never draws. A dynamic
 * import from a client component puts each face in its own chunk instead, and
 * only the chunk for this locale is ever asked for.
 *
 * The face lands as a rule on <html> rather than as a class, because a
 * component cannot put a class on an ancestor and body's own font-family has to
 * see the variable too.
 */
function variableRule(face: Face) {
  return function ScriptVariable() {
    return <style href="script-face" precedence="medium">{`html{--font-script:${face.style.fontFamily}}`}</style>;
  };
}

const faces = {
  ta: dynamic(() => import("@/lib/fonts/script/ta").then((m) => ({ default: variableRule(m.face) }))),
  hi: dynamic(() => import("@/lib/fonts/script/hi").then((m) => ({ default: variableRule(m.face) }))),
  zh: dynamic(() => import("@/lib/fonts/script/zh").then((m) => ({ default: variableRule(m.face) }))),
  ja: dynamic(() => import("@/lib/fonts/script/ja").then((m) => ({ default: variableRule(m.face) }))),
  ko: dynamic(() => import("@/lib/fonts/script/ko").then((m) => ({ default: variableRule(m.face) }))),
} as const;

/** True for the languages the Latin faces cannot draw. */
export function hasScriptFace(locale: string): locale is keyof typeof faces {
  return locale in faces;
}

export function ScriptFace({ locale }: { locale: string }) {
  if (!hasScriptFace(locale)) {
    return null;
  }

  const Face = faces[locale];
  return <Face />;
}
