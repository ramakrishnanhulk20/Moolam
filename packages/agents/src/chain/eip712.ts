// The passport and bind digests live in the verify service, which is the only place that both
// signs for the generator agent and serves the studio. The verifier package declares no "exports"
// and ships no build, so its modules are imported by file path: Node, TypeScript and tsx all
// follow the workspace link.
export * from "@moolam/verifier/src/generate/eip712.js";
