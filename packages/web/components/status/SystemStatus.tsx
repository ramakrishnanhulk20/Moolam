import { getTranslations } from "next-intl/server";
import { currentStatus } from "@/lib/status/current";

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
      detail: index.state === "live" ? t("block", { block: index.block }) : null,
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
