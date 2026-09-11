import rehypeShiki from "@shikijs/rehype";
import type { Element, Nodes, Root } from "hast";
import { toJsxRuntime, type Components } from "hast-util-to-jsx-runtime";
import type { Code } from "mdast";
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
 * A mermaid fence is a drawing, not code, so it leaves the pipeline here and
 * never reaches the highlighter. Everything else becomes the pre and code pair
 * the highlighter expects.
 */
function codeToHast(state: State, node: Code): Element {
  if (node.lang === "mermaid") {
    const drawing: Element = {
      type: "element",
      tagName: "div",
      properties: { className: [mermaidClass] },
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
    if (className === mermaidClass) {
      return <Mermaid chart={node === undefined ? "" : textOf(node)} />;
    }
    return (
      <div className={className} {...rest}>
        {children}
      </div>
    );
  },
  table({ children, ...rest }) {
    // A reference table is wider than a phone. Its own scroller keeps the page
    // itself from sliding sideways under the reader.
    return (
      <div className="docs-table">
        <table {...rest}>{children}</table>
      </div>
    );
  },
};

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
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
