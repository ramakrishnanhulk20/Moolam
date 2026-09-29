import type { ReactNode } from "react";

/**
 * Stands in for an address inside a translated sentence, so the address can be
 * drawn in its own normal-case span while the words around it keep the label's
 * capitals. A private-use character, so no language's sentence contains it.
 */
export const HEX_MARK = "";

/** The sentence with the address put back where the mark was, in lower case hex whatever the row is set in. */
export function withHex(sentence: string, hex: string): ReactNode {
  const [before, after = ""] = sentence.split(HEX_MARK);
  return (
    <>
      {before}
      <span data-hex className="normal-case">
        {hex}
      </span>
      {after}
    </>
  );
}
