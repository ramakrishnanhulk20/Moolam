import type { FastifyInstance } from "fastify";

/**
 * Liveness, how much the index is holding, which routes this host mounted, and how much of
 * today's budget for everyone is gone.
 *
 * The route list is what makes a misconfigured deploy visible from outside: a host missing a key
 * still boots and still verifies, and `routes` is where that shows up.
 *
 * `limits` is how the daily check sees a ceiling coming before creators do, and `limits.links` is how
 * many read links to private copies were minted today against GLOBAL_LINKS_PER_DAY (B15). It counts
 * the whole world, never one person: nothing here names a caller, a user id or an address.
 *
 * `recheck` is how many second opinions are waiting and how many a runner is working on, which is
 * where a runner that has died shows up from outside: the pending count climbs and nothing runs.
 *
 * `sweep` is the private copy sweep's mode and its last run: when it started, whether it finished
 * or stopped on a doubt, and its counts. Never a file name, a file id, a link or a reason, which
 * stay in the host's own log.
 */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  // A probe that can be refused lies about the service: a status footer, an uptime monitor or a
  // build pre-rendering hundreds of pages would read the 61st answer in a minute as "down". The
  // answer costs microseconds, so the limiter skips this route and nothing else.
  app.get("/health", { config: { rateLimit: false } }, async () => ({
    ok: true,
    records: app.verifier.index.size,
    version: app.verifier.version,
    routes: app.verifier.routes,
    limits: app.globalDay.counts(),
    recheck: app.recheck.counts(),
    sweep: app.privateSweep.state(),
  }));
}
