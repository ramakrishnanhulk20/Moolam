import Opening from "@/app/[locale]/loading";

/**
 * The studio carries the wallet and is never fetched ahead, so this is the
 * screen a press on Make shows while it arrives.
 */
export default function StudioLoading() {
  return <Opening frame="page" />;
}
