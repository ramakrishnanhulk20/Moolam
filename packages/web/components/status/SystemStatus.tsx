import { getTranslations } from "next-intl/server";
import { currentStatus } from "@/lib/status/current";
import type { IndexStatus } from "@/lib/status/read";

interface Item {
  key: string;
  label: string;
  state: string;
  detail: string | null;
  live: boolean;
}

/**
 * The footer's live line: the verify service, the index and the chain, read
 * when the page is rendered and never faked. Every figure on it comes from the
 * service itself, so a red dot here means the thing is genuinely down.
 *
 * It is rendered inside a Suspense boundary, so the page never waits on it. The
 * reads cap themselves at three seconds and report unreachable after that.
 */
export async function SystemStatus() {
  const t = await getTranslations("footer.status");
  const status = await currentStatus();

  const items: Item[] = [
    status.verifier.state === "live"
      ? {
          key: "verifier",
          label: t("verifier"),
          state: t("live"),
          detail: t("records", { count: status.verifier.records }),
          live: true,
        }
      : { key: "verifier", label: t("verifier"), state: t("unreachable"), detail: null, live: false },
  ];

  if (status.index !== null) {
    const index = status.index;
    items.push({
      key: "index",
      label: t("index"),
      state: index.state === "live" ? t("live") : index.state === "behind" ? t("behind", { blocks: index.blocks }) : t("unreachable"),
      // The gap is what an index is for, so the line says it rather than
      // leaving a reader to subtract the footer's two block numbers.
      detail: index.state === "unreachable" ? null : gapLine(index, t),
      live: index.state === "live",
    });
  }

  items.push(
    status.chain.state === "live"
      ? {
          key: "chain",
          label: t("chain"),
          state: t("live"),
          detail: t("block", { block: status.chain.block }),
          live: true,
        }
      : { key: "chain", label: t("chain"), state: t("unreachable"), detail: null, live: false },
  );

  return (
    <ul className="status-line flex flex-wrap items-center gap-x-5 gap-y-1.5">
      {items.map((item) => (
        <li
          key={item.key}
          className="group flex items-center gap-2 transition-colors duration-200 hover:text-text-muted"
        >
          <span aria-hidden className={item.live ? "status-dot is-live" : "status-dot is-down"} />
          <span>{item.label}</span>
          <span className={item.live ? "text-verified" : "text-failed"}>{item.state}</span>
          {item.detail === null ? null : (
            <span className="text-text-faint transition-colors duration-200 group-hover:text-text-muted">
              {item.detail}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

type Translate = (key: string, values?: Record<string, number>) => string;

/**
 * How far the index is trailing the chain, in words.
 *
 * Blocks are the only honest unit here: the index reports the block it has
 * finished and nothing about when it got there, so a time would have to be
 * invented. A head that could not be read costs the gap and not the block.
 */
function gapLine(index: Exclude<IndexStatus, { state: "unreachable" }>, t: Translate): string {
  if (index.state === "behind") {
    return t("gap", { block: index.block, blocks: index.blocks });
  }
  if (index.behind === null) {
    return t("block", { block: index.block });
  }
  return index.behind === 0 ? t("inStep", { block: index.block }) : t("gap", { block: index.block, blocks: index.behind });
}

/**
 * What stands in the line's place while the three reads run. It carries the
 * same labels so the footer does not jump when the answers land.
 */
export function StatusPending({ labels }: { labels: string[] }) {
  return (
    <ul className="status-line flex flex-wrap items-center gap-x-5 gap-y-1.5" aria-hidden>
      {labels.map((label) => (
        <li key={label} className="flex items-center gap-2 opacity-50">
          <span className="status-dot is-waiting" />
          <span>{label}</span>
        </li>
      ))}
    </ul>
  );
}
