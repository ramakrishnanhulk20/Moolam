// The generator agent's signing lives in the verify service, so the hosted /generate route and the
// scripts in this package produce the same signature over the same struct. The verifier package
// declares no "exports" and ships no build, so its modules are imported by file path.
export * from "@moolam/verifier/src/generate/generatorSigner.js";
