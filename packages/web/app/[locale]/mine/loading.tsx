import Opening from "@/app/[locale]/loading";

/**
 * My pictures carries the wallet and is never fetched ahead, so this is the
 * screen a press on Mine shows while it arrives.
 */
export default function MineLoading() {
  return <Opening frame="page" />;
}
