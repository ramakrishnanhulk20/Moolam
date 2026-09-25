import { connection } from "next/server";
import { reason } from "@/lib/chain/client";
import { heldGeneratorStandings } from "@/lib/data/passports";
import { Board } from "./Board";
import { roster, type AgentRow } from "./roster";

/**
 * The roster, read for the page the build makes.
 *
 * Two sources, each doing what only it can: the index adds up the passports and
 * the re-checks, the identity registry on Monad says who the agent is. An
 * identity registry that will not answer costs a name and nothing else, so only
 * the index read can fail this page.
 */
export async function AgentsSheet({ locale }: { locale: string }) {
  let agents: AgentRow[] = [];
  let error: string | null = null;

  try {
    agents = await roster(await heldGeneratorStandings());
  } catch (problem) {
    error = reason(problem);
  }

  if (error !== null) {
    // A read that failed once must never become the page everybody is handed
    // for the next minute. Asking for the connection takes this render out of
    // the store: a build leaves the page to be drawn on the request instead,
    // and a refresh keeps the last good board it already has and tries again on
    // the next request.
    await connection();
  }

  return <Board agents={agents} error={error} locale={locale} />;
}
