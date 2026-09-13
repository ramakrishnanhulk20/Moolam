// The Privy client lives in the verify service, so the hosted /generate route and the scripts in
// this package talk to Privy through one client and read the same three variables from the root
// .env. The verifier package declares no "exports" and ships no build, so its modules are imported
// by file path: Node, TypeScript and tsx all follow the workspace link.
export * from "@moolam/verifier/src/generate/privy.js";
