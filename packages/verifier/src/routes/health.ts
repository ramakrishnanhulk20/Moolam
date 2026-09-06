import type { FastifyInstance } from "fastify";

/** Liveness and a look at how much the index is holding. */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => ({
    ok: true,
    records: app.verifier.index.size,
    version: app.verifier.version,
  }));
}
