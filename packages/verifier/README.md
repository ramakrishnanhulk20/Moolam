# @moolam/verifier

Fingerprints an image three ways (exact sha256, a 64-bit pHash, a 256-bit blockhash), reads and writes C2PA manifests, and applies the eight transforms a re-upload puts an image through.

Run the measurement spike from the repo root:

```sh
npm install
npm run spike:verifier
```

It writes its test images to `packages/verifier/test-assets/` (gitignored) and prints the installed library versions, one row per transform with the two fingerprint distances, and whether the C2PA manifest survived.

Signing certificate: the npm package of `@contentauth/c2pa-node` ships only `dist`, `scripts` and `src`, so the test certificates in its GitHub repository are not installed with it. On first run the package generates its own throwaway ES256 chain (a root plus a signer) into `test-assets/certs/` with openssl. Manifests signed with it read back as `signingCredential.untrusted`, which is correct: it is not on the public C2PA trust list. Point `MOOLAM_C2PA_CERT_PATH` and `MOOLAM_C2PA_KEY_PATH` at a real certificate and key to sign with a trusted identity.
