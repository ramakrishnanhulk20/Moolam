import rehypeShiki from "@shikijs/rehype";
import type { Element, ElementContent, Nodes, Root } from "hast";
import { toJsxRuntime, type Components } from "hast-util-to-jsx-runtime";
import type { Code, Root as MarkdownRoot } from "mdast";
import type { State } from "mdast-util-to-hast";
import type { ReactElement } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { CONTINUE, SKIP, visit } from "unist-util-visit";
import { BreakIt } from "@/components/docs/BreakIt";
import { CodeBlock } from "@/components/docs/CodeBlock";
import { DocsLink } from "@/components/docs/DocsLink";
import { Mermaid } from "@/components/docs/Mermaid";
import { resolveLink } from "./links";
import type { Heading } from "./tree";

export type { Heading };

export type RenderedPage = {
  /** The headline the page carries at the top of its markdown. */
  heading: string | null;
  headings: Heading[];
  /** The prose of the page with no markup on it, which is what search reads. */
  text: string;
  content: ReactElement;
};

const mermaidClass = "mermaid-source";

/**
 * The fence that mounts the attack screen. It carries no source of its own:
 * the twelve attacks are data in components/docs/breakIt, because each one has
 * to match a transcript that was executed against the live contracts.
 */
const breakItClass = "break-it-mount";

export type DiagramVariant = "both" | "wide" | "phone";

/**
 * The info string on a drawing's fence.
 *
 * A plain ```mermaid fence is one drawing for every screen. A ```mermaid phone
 * fence is a redraw of the fence above it for a narrow screen, and it may carry
 * a line of its own in quotes, which is printed above the drawing. That line is
 * how two stacked phone drawings say which half of the story each one tells.
 *
 * Any fence may also carry height=620: the height in pixels the finished frame
 * measured on the screen it shows on, a laptop for a wide drawing and a phone
 * for a redraw. The page holds that much room while mermaid draws, so nothing
 * below a drawing moves when it arrives.
 */
export function readDiagramMeta(meta: string | null | undefined): {
  variant: DiagramVariant;
  caption: string | null;
  height: number | null;
} {
  const text = (meta ?? "").trim();
  const quoted = /"([^"]*)"/.exec(text);
  const word = text.split(/\s+/)[0] ?? "";
  const variant: DiagramVariant = word === "phone" ? "phone" : word === "wide" ? "wide" : "both";
  const hint = /(?:^|\s)height=(\d+)(?:\s|$)/.exec(text.replace(/"[^"]*"/g, ""));
  const height = hint === null ? null : Number(hint[1]);
  return {
    variant,
    caption: quoted === null ? null : quoted[1].trim(),
    height: height !== null && height > 0 ? height : null,
  };
}

function diagramMeta(variant: DiagramVariant, height: number | null): string {
  return height === null ? variant : `${variant} height=${height}`;
}

/**
 * A wide drawing that is followed by a phone redraw is marked as the wide half
 * of a pair, so the page can show one or the other by screen width. A drawing
 * with no redraw after it keeps every screen, since it already fits.
 */
function pairDiagrams() {
  return (tree: MarkdownRoot): void => {
    visit(tree, "code", (node: Code, index, parent) => {
      if (node.lang !== "mermaid" || parent === undefined || index === undefined) {
        return;
      }
      if (readDiagramMeta(node.meta).variant === "phone") {
        return;
      }
      let at = index + 1;
      let paired = false;
      while (at < parent.children.length) {
        const next = parent.children[at];
        if (next.type !== "code" || next.lang !== "mermaid" || readDiagramMeta(next.meta).variant !== "phone") {
          break;
        }
        paired = true;
        at += 1;
      }
      node.meta = diagramMeta(paired ? "wide" : "both", readDiagramMeta(node.meta).height);
    });
  };
}

/**
 * A mermaid fence is a drawing, not code, so it leaves the pipeline here and
 * never reaches the highlighter. Everything else becomes the pre and code pair
 * the highlighter expects.
 */
function codeToHast(state: State, node: Code): Element {
  if (node.lang === "break-it") {
    const mount: Element = {
      type: "element",
      tagName: "div",
      properties: { className: [breakItClass] },
      children: [],
    };
    state.patch(node, mount);
    return mount;
  }
  if (node.lang === "mermaid") {
    const { variant, caption, height } = readDiagramMeta(node.meta);
    const drawing: Element = {
      type: "element",
      tagName: "div",
      properties: {
        className: [mermaidClass],
        dataVariant: variant,
        dataCaption: caption ?? undefined,
        dataHeight: height ?? undefined,
      },
      children: [{ type: "text", value: node.value }],
    };
    state.patch(node, drawing);
    return drawing;
  }
  const code: Element = {
    type: "element",
    tagName: "code",
    properties: { className: node.lang === null || node.lang === undefined ? [] : [`language-${node.lang}`] },
    children: [{ type: "text", value: `${node.value}\n` }],
  };
  const pre: Element = { type: "element", tagName: "pre", properties: {}, children: [code] };
  state.patch(node, pre);
  return pre;
}

/** The text a reader sees, with the little anchor mark beside a heading left out. */
function textOf(node: Nodes): string {
  if (node.type === "text") {
    return node.value;
  }
  if (node.type === "element" && String(node.properties?.className ?? "").includes("docs-anchor")) {
    return "";
  }
  return "children" in node ? node.children.map(textOf).join("") : "";
}

/**
 * The page headline is drawn by the masthead in the app's display face, so the
 * markdown copy of it comes out of the body. Its words are handed back.
 */
function takeHeadline(tree: Root): string | null {
  const at = tree.children.findIndex((child) => child.type === "element" && child.tagName === "h1");
  if (at === -1) {
    return null;
  }
  const [headline] = tree.children.splice(at, 1);
  return textOf(headline).trim();
}

function collectText(tree: Root): string {
  const parts: string[] = [];
  visit(tree, "element", (node) => {
    if (["p", "li", "td", "th", "blockquote"].includes(node.tagName)) {
      parts.push(textOf(node).trim());
      return SKIP;
    }
    return CONTINUE;
  });
  return parts.filter((part) => part !== "").join(" ").replace(/\s+/g, " ");
}

function collectHeadings(tree: Root): Heading[] {
  const headings: Heading[] = [];
  visit(tree, "element", (node) => {
    if (node.tagName !== "h2" && node.tagName !== "h3") {
      return;
    }
    const id = typeof node.properties.id === "string" ? node.properties.id : "";
    if (id !== "") {
      headings.push({ id, text: textOf(node).trim(), depth: node.tagName === "h2" ? 2 : 3 });
    }
  });
  return headings;
}

/**
 * Links are written the way they read on GitHub, relative to the file. Here they
 * become app routes, so a page link is a client navigation and a transcript is
 * served by the files route.
 */
function rewriteLinks(tree: Root, slug: string): void {
  visit(tree, "element", (node) => {
    if (node.tagName === "a" && typeof node.properties.href === "string") {
      const link = resolveLink(slug, node.properties.href);
      node.properties.href = link.href;
      node.properties.dataLink = link.kind;
      return;
    }
    if (node.tagName === "img" && typeof node.properties.src === "string") {
      const link = resolveLink(slug, node.properties.src);
      node.properties.src = link.href;
    }
  });
}

/** From this many columns up a table is too wide to read as a grid on a phone. */
export const WIDE_TABLE_COLUMNS = 4;

/**
 * The places a path or a test name may wrap: after a slash or an underscore, and
 * where a lower case letter meets an upper case one. Without these the browser
 * breaks inline code wherever the cell runs out, which cut
 * "packages/contracts/src/MoolamRegistry.sol" every fifteen characters.
 */
export function wordJoints(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let at = 1; at < text.length; at += 1) {
    const before = text[at - 1];
    const here = text[at];
    if (before === "/" || before === "_" || (/[a-z]/.test(before) && /[A-Z]/.test(here))) {
      parts.push(text.slice(start, at));
      start = at;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** Puts a line-break chance at every word joint of the text inside a code span. */
function breakAtJoints(code: Element): void {
  code.children = code.children.flatMap((child): ElementContent[] => {
    if (child.type !== "text") {
      return [child];
    }
    return wordJoints(child.value).flatMap((part, index): ElementContent[] =>
      index === 0
        ? [{ type: "text", value: part }]
        : [{ type: "element", tagName: "wbr", properties: {}, children: [] }, { type: "text", value: part }],
    );
  });
}

function childElements(node: Element, tagName: string): Element[] {
  return node.children.filter((child): child is Element => child.type === "element" && child.tagName === tagName);
}

/**
 * A reference table of four or more columns is marked so the page can give it
 * room: every body cell carries its column's header as data-label, which is what
 * a phone prints above the cell when it stacks each row as a card, and the code
 * in its cells wraps at word joints only. The rendered output changes; the text
 * search reads was taken before this runs.
 */
function markWideTables(tree: Root): void {
  visit(tree, "element", (table) => {
    if (table.tagName !== "table") {
      return CONTINUE;
    }
    const head = childElements(table, "thead")[0];
    const headRow = head === undefined ? undefined : childElements(head, "tr")[0];
    const labels = headRow === undefined ? [] : childElements(headRow, "th").map((cell) => textOf(cell).trim());
    if (labels.length < WIDE_TABLE_COLUMNS) {
      return SKIP;
    }
    table.properties.dataColumns = labels.length;
    // The phone layout turns rows and cells into blocks, and some screen readers
    // stop reading a table as a table once its parts are blocks. The roles say
    // it plainly, so the grid survives the restyle.
    table.properties.role = "table";
    for (const group of [...childElements(table, "thead"), ...childElements(table, "tbody")]) {
      group.properties.role = "rowgroup";
      for (const row of childElements(group, "tr")) {
        row.properties.role = "row";
      }
    }
    for (const cell of headRow === undefined ? [] : childElements(headRow, "th")) {
      cell.properties.role = "columnheader";
    }
    for (const body of childElements(table, "tbody")) {
      for (const row of childElements(body, "tr")) {
        childElements(row, "td").forEach((cell, index) => {
          cell.properties.role = "cell";
          cell.properties.dataLabel = labels[index] ?? "";
          visit(cell, "element", (inner) => {
            if (inner.tagName === "code") {
              breakAtJoints(inner);
              return SKIP;
            }
            return CONTINUE;
          });
        });
      }
    }
    return SKIP;
  });
}

const components: Partial<Components> = {
  a({ node, children, href, ...rest }) {
    const kind = String((node?.properties.dataLink ?? "external") as string);
    return (
      <DocsLink href={href ?? ""} kind={kind} {...rest}>
        {children}
      </DocsLink>
    );
  },
  pre({ node, children, className, style }) {
    return (
      <CodeBlock code={node === undefined ? "" : textOf(node)} className={className} style={style}>
        {children}
      </CodeBlock>
    );
  },
  div({ node, children, className, ...rest }) {
    if (className === breakItClass) {
      return <BreakIt />;
    }
    if (className === mermaidClass) {
      const held = node?.properties ?? {};
      const variant = typeof held.dataVariant === "string" ? (held.dataVariant as DiagramVariant) : "both";
      const caption = typeof held.dataCaption === "string" ? held.dataCaption : null;
      const height = typeof held.dataHeight === "number" ? held.dataHeight : null;
      return (
        <Mermaid chart={node === undefined ? "" : textOf(node)} variant={variant} caption={caption} height={height} />
      );
    }
    return (
      <div className={className} {...rest}>
        {children}
      </div>
    );
  },
  table({ node, children, ...rest }) {
    // A reference table is wider than a phone. Its own scroller keeps the page
    // itself from sliding sideways under the reader.
    const wide = node?.properties.dataColumns !== undefined;
    return (
      <div className={wide ? "docs-table docs-table-wide" : "docs-table"}>
        <table {...rest}>{children}</table>
      </div>
    );
  },
};

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(pairDiagrams)
  // No allowDangerousHtml: raw HTML written in a page is dropped rather than
  // rendered, so no page can run a script.
  .use(remarkRehype, { handlers: { code: codeToHast } })
  .use(rehypeSlug)
  .use(rehypeAutolinkHeadings, {
    behavior: "append",
    properties: { className: ["docs-anchor"], ariaHidden: "true", tabIndex: -1 },
    content: { type: "element", tagName: "span", properties: {}, children: [{ type: "text", value: "#" }] },
  })
  .use(rehypeShiki, {
    themes: { light: "github-light", dark: "github-dark" },
    defaultColor: false,
    fallbackLanguage: "text",
  });

const rendered = new Map<string, Promise<RenderedPage>>();

async function render(slug: string, body: string): Promise<RenderedPage> {
  const tree = (await processor.run(processor.parse(body))) as Root;
  const heading = takeHeadline(tree);
  const headings = collectHeadings(tree);
  const text = collectText(tree);
  rewriteLinks(tree, slug);
  markWideTables(tree);
  const content = toJsxRuntime(tree, { Fragment, jsx, jsxs, components, passNode: true }) as ReactElement;
  return { heading, headings, text, content };
}

/**
 * The same page is rendered once and read in ten languages: the words are
 * English in every one of them, and the links carry no language, so the result
 * is worth keeping for the length of the build.
 */
export function renderPage(slug: string, body: string): Promise<RenderedPage> {
  const already = rendered.get(slug);
  if (already !== undefined) {
    return already;
  }
  const work = render(slug, body);
  rendered.set(slug, work);
  return work;
}
