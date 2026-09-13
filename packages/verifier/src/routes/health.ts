import type { FastifyInstance } from "fastify";

/**
 * Liveness, how much the index is holding, and which routes this host mounted.
 *
 * The route list is what makes a misconfigured deploy visible from outside: a host missing a key
 * still boots and still verifies, and `routes` is where that shows up.
 */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => ({
    ok: true,
    records: app.verifier.index.size,
    version: app.verifier.version,
    routes: app.verifier.routes,
  }));
}
