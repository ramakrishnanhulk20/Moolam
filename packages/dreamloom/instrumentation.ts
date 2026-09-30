/**
 * Next.js calls register once when a server process starts. Dreamloom's start work touches the
 * disk and the kit, which exist only in the Node.js runtime, so the edge runtime skips it and the
 * import stays out of its bundle.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startServer } = await import("./lib/server/boot");
  startServer();
}
