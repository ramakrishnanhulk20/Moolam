// The prepare pipeline lives in the verify service, which is the only place that both signs
// manifests and serves the studio. The verifier package declares no "exports" and ships no build,
// so its modules are imported by file path: Node, TypeScript and tsx all follow the workspace link.
export * from "@moolam/verifier/src/prepare.js";
