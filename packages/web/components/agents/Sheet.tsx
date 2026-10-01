import { connection } from "next/server";
import { reason } from "@/lib/chain/client";
import { heldGeneratorStandings } from "@/lib/data/passports";
import { Board } from "./Board";
import { roster, type AgentRow } from "./roster";
import { newestRegistration } from "./fresh";
import { boardStrips, type AgentStrip } from "./strip";

/**
 * The roster, read on every visit. A failed read is therefore never kept as
 * the page later visitors are handed.
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

  // Drawn on every visit, so nobody is handed a board made before the newest
  // passport. The reads under it stay held and are filed under that passport.
  await connection();
  const newest = await newestRegistration();

  // Read side by side: the strips are one query for the whole board and do
  // not wait on the names.
  const [listed, pictured] = await Promise.allSettled([
    heldGeneratorStandings(undefined, newest).then((standings) => roster(standings)),
    boardStrips(newest),
  ]);

  if (listed.status === "fulfilled") {
    agents = listed.value;
  } else {
    error = reason(listed.reason);
  }
  if (pictured.status === "fulfilled") {
    strips = pictured.value;
  }

  return <Board agents={agents} error={error} locale={locale} strips={strips} />;
}
