import Opening from "@/components/shell/Opening";

/**
 * The agents board is refreshed on the request behind whoever asks, so a press
 * on it can wait on the index; this is the screen that wait shows.
 */
export default function AgentsLoading() {
  return <Opening frame="page" />;
}
