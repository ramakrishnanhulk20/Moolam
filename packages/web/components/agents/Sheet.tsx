import { connection } from "next/server";
import { reason } from "@/lib/chain/client";
import { heldGeneratorStandings } from "@/lib/data/passports";
import { Board } from "./Board";
import { roster, type AgentRow } from "./roster";
import { boardStrips, type AgentStrip } from "./strip";

/**
 * The roster, read for the page the build makes.
 *
 * Three sources, each doing what only it can: the index adds up the passports
 * and the re-checks and lists each agent's newest passports, the identity
 * registry on Monad says who the agent is, and the pinned documents say which
 * of those passports are real pictures. An identity registry that will not
 * answer costs a name and nothing else, and a strip that will not read costs
 * the pictures, so only the roster read can fail this page.
 */
export async function AgentsSheet({ locale }: { locale: string }) {
  let agents: AgentRow[] = [];
  let error: string | null = null;
  let strips: Record<string, AgentStrip> | null = null;

  // Read side by side: the strips are one query for the whole board and do
  // not wait on the names.
  const [listed, pictured] = await Promise.allSettled([
    heldGeneratorStandings().then((standings) => roster(standings)),
    boardStrips(),
  ]);

  if (listed.status === "fulfilled") {
    agents = listed.value;
  } else {
    error = reason(listed.reason);
  }
  if (pictured.status === "fulfilled") {
    strips = pictured.value;
  }

  if (error !== null || (strips === null && agents.length > 0)) {
    // A read that failed once must never become the page everybody is handed
    // for the next minute. Asking for the connection takes this render out of
    // the store: a build leaves the page to be drawn on the request instead,
    // and a refresh keeps the last good board it already has and tries again on
    // the next request. A board with its names and no pictures is the same
    // kind of miss.
    await connection();
  }

  return <Board agents={agents} error={error} locale={locale} strips={strips} />;
}
