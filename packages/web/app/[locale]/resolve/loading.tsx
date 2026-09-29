import Opening from "@/components/shell/Opening";

/**
 * The resolver's queue is read from the index and the registry on every
 * request, so a press on it shows this while both answer.
 */
export default function ResolveLoading() {
  return <Opening frame="page" />;
}
