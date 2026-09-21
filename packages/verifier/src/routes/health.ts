import type { FastifyInstance } from "fastify";

/**
 * Liveness, how much the index is holding, which routes this host mounted, and how much of
 * today's budget for everyone is gone.
 *
 * The route list is what makes a misconfigured deploy visible from outside: a host missing a key
 * still boots and still verifies, and `routes` is where that shows up.
 *
 * `limits` is how the daily check sees a ceiling coming before creators do. It counts the whole
 * world, never one person: nothing here names a caller, a user id or an address.
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
  }));
}
