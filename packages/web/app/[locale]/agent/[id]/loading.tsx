import Opening from "@/app/[locale]/loading";

/** An agent opens under its own poster band, so the wait holds that height. */
export default function AgentLoading() {
  return <Opening frame="agent" />;
}
