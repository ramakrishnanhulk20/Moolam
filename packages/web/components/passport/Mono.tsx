import { Fragment } from "react";

/** How many characters ride together before a line is allowed to break. */
const GROUP = 8;

/**
 * A long hex value cut into groups.
 *
 * Exported for the test: the rule is that the groups joined back together are
 * the value, unchanged. Nothing here may add, drop or reorder a character.
 */
export function groups(value: string, size = GROUP): string[] {
  // A value with a space in it is already made of words a line may break
  // between, and cutting those into eights would break them mid word.
  if (/\s/.test(value)) {
    return [value];
  }

  const out: string[] = [];
  for (let at = 0; at < value.length; at += size) {
    out.push(value.slice(at, at + size));
  }
  return out.length === 0 ? [value] : out;
}

/**
 * A hash or an address, wrapped at points somebody chose.
 *
 * The value is drawn as groups of eight with a break opportunity between them,
 * so a wrapped address still reads as an address rather than leaving one letter
 * alone on the second line. break-all is the floor under that: a value the
 * grouping leaves whole, such as the metadata line "IPFS bafkrei...", is one
 * 60 character word, and without it that word sets the width of the whole
 * column and pushes a 375 px page sideways. It is the same class the footer
 * address uses.
 */
export function Mono({ value, className }: { value: string; className?: string }) {
  return (
    <span className={className === undefined ? "font-mono break-all" : `font-mono break-all ${className}`}>
      {groups(value).map((group, index) => (
        <Fragment key={`${index}-${group}`}>
          {index === 0 ? null : <wbr />}
          {group}
        </Fragment>
      ))}
    </span>
  );
}
