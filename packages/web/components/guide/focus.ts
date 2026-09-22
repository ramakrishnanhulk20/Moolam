/**
 * Keeping a keyboard inside the guide while it is open, and keeping the page
 * under it still.
 *
 * Both are plain functions rather than hooks so they can be tested on their own
 * without mounting anything.
 */

const REACHABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/** Everything inside the panel a Tab could land on, in the order Tab would visit it. */
export function reachableIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(REACHABLE)].filter(
    (node) => !node.hasAttribute("hidden") && node.getAttribute("aria-hidden") !== "true",
  );
}

/**
 * Where Tab should go, or null when the browser's own answer is already right.
 *
 * Returning the element instead of moving focus keeps the rule readable and
 * lets a test check it without a real focus ring: a Tab off the last control
 * comes back to the first, a Shift+Tab off the first goes to the last, and
 * focus that has somehow landed outside the panel is pulled back in.
 */
export function tabTarget(root: HTMLElement, active: Element | null, back: boolean): HTMLElement | null {
  const reachable = reachableIn(root);
  if (reachable.length === 0) {
    return root;
  }

  const first = reachable[0];
  const last = reachable[reachable.length - 1];

  if (active === null || !root.contains(active)) {
    return back ? last : first;
  }
  if (!back && active === last) {
    return first;
  }
  if (back && active === first) {
    return last;
  }
  return null;
}

/**
 * Holds the page still while the guide is over it, and hands it back exactly as
 * it was.
 *
 * The bar the scrollbar leaves behind is added as padding, because taking the
 * scrollbar away without it slides every line of the page sideways by fifteen
 * pixels on open and back on close, which is a layout shift a visitor sees and
 * a measurement tool counts.
 */
export function lockPage(): () => void {
  const root = document.documentElement;
  const body = document.body;
  const bar = window.innerWidth - root.clientWidth;

  const heldOverflow = body.style.overflow;
  const heldPadding = body.style.paddingRight;

  body.style.overflow = "hidden";
  if (bar > 0) {
    const already = Number.parseFloat(window.getComputedStyle(body).paddingRight) || 0;
    body.style.paddingRight = `${already + bar}px`;
  }

  return () => {
    body.style.overflow = heldOverflow;
    body.style.paddingRight = heldPadding;
  };
}
