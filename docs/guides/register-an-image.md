---
title: Register an image
---

# Register an image

Everything the studio can be in, and everything it can say when a step does not finish. If you just
want the happy path, read [Your first passport](../getting-started/your-first-passport) instead.

The studio is at "Register an image" in the header. It takes human uploads, which register as
Captured passports with no generator agent. A picture an AI made registers through the agent
instead, and that path is in
[Agents and generated images](agents-and-generated-images).

## What the file has to be

| Limit | Value | Where it is enforced |
| --- | --- | --- |
| File type | JPEG, PNG or WebP | The file picker, then the verify service |
| File size | 20 MB | Checked in the browser first, then again by the service |
| Pixels | 40 megapixels | The service, before a pixel is decoded |
| Title | 1 to 120 characters | The browser input caps at 120, the service refuses anything outside |
| How often | 20 prepares an hour per signed-in account | The service, counted on the Privy user id from your token |

The pixel cap exists because a 572 KB JPEG can unpack to 100 megapixels. The hourly cap exists
because every prepare spends four IPFS pins and about a second of CPU.

## The states, in order

### Signed out

The card reads "You are not signed in" over "Sign in and an account is made for you". One button:
"Sign in and create my account". See [Sign in and account](../getting-started/sign-in-and-account).

### Opening your account

"Opening your account" while Privy finishes the session and hands over the embedded wallet. If it
finishes with no wallet, the page says "You are signed in, but no account was created on Monad yet.
Reload the page, or sign out and sign in again."

### Reading the passkey

"Checking whether this account already has a passkey" while the studio reads `getPasskey` for your
account off the registry. Nothing local is trusted for this: the chain is the answer.

If Monad cannot be read, the page says so, prints the RPC's own reason and asks you to reload. It
does not guess, and it does not offer a bind it might not need.

### Signed in, no passkey yet

The bind card, headed "One setup step". One button, "Use this device's unlock", and four wait lines
while it runs. Covered step by step in
[Your first passport](../getting-started/your-first-passport).

### Passkey on another device

The chain says a key is bound and this browser has never used it. The card reads "Another device
signed here" over "Your passkey was set up somewhere else", with "Unlock with my passkey" and "Bind
this device instead".

The unlock path is a read, not a write: the passkey signs a throwaway challenge with no credential
filter, and the browser checks the answer against the key the chain already holds. That is how this
browser learns which credential belongs to your account without spending a transaction to find out.

### Ready to register

The card reads "Ready" over "Give an image its passport". Drop area, title field, and "Register
this image". Three step rows sit under the button and light up in order.

### Preparing

"Fingerprinting and pinning, about ten seconds". The browser posts the file straight to the verify
service with your Privy access token. The service turns it upright, embeds the C2PA manifest,
fingerprints the signed bytes, makes a thumbnail, and pins four files to IPFS. Nothing has gone to
Monad, so a failure here costs no gas.

Finishes as "Fingerprinted, manifest embedded, pinned to IPFS".

### Waiting for the passkey

"Waiting for your fingerprint or face unlock". The studio reads `hashPassport` from the registry
for the exact fields it is about to send, hands that digest to your passkey as the WebAuthn
challenge, and verifies the assertion in the browser before spending anything.

Finishes as "Signed on this device".

### Sending

"Sending to Monad, network fee sponsored", then "Waiting for Monad to record the passport". The
call is simulated first, because a revert costs nothing there and comes back with a name the ABI
can decode, where a reverted transaction on chain only ever says reverted. Then the studio polls
the registry once a second for up to 90 seconds, racing the transaction receipt against the poll.

Finishes as "Written to Monad".

### Registered

"This image now has a passport" over the pinned copy of your file, with the passport id, the block,
the time, who paid the fee, and links to the passport page, the transaction on MonadVision, the
pinned image and "Register another image".

## Every failure, and what to do next

Each row is the exact sentence the screen prints, and the single button it offers under it. Where
the service or the browser had its own words, they are printed underneath in monospace.

### Before anything leaves the browser

| Message | What happened | Button |
| --- | --- | --- |
| "Choose an image first." | You pressed register with no file | none |
| "Give the picture a title first. It goes into the manifest." | The title was blank or only spaces | none |
| "That file is over the 20 MB limit. Export it smaller and try again." | The browser checked the size before uploading | none |
| "That file is not a JPEG, a PNG or a WebP image. Choose an image file." | The browser checked the type before uploading | none |

### While preparing

| Message | What happened | Button |
| --- | --- | --- |
| "The Moolam verify service is not answering, so nothing was uploaded. Try again in a moment." | The service is down or unreachable | "Try again" |
| "Your session has expired. Sign in again and the upload will work." | The service answered 401: your Privy access token was missing or past its expiry | "Sign in again" |
| "This account has prepared 20 images in the last hour, which is the limit. Try again later." | The service answered 429 on the per-account hourly cap | none |
| "The image could not be pinned to IPFS, so nothing was registered. Try again in a moment." | Pinata refused a pin, so the service answered 502 | "Try again" |
| "The verify service refused this upload. What it said is below." | A 400: not a multipart body, a file part under the wrong name, an empty file, a bad title, or a kind other than human | none |
| "The verify service answered in a shape this page does not understand, so nothing was signed. Try again." | The answer did not match the schema this page reads | "Try again" |

The size and type messages appear here too, because the service checks both again and its answer is
the one that counts.

### At the passkey prompt

| Message | What happened | Button |
| --- | --- | --- |
| "The unlock prompt was closed or it timed out. Nothing was signed." | You dismissed the prompt, or the device gave up waiting | "Try again" |
| "This passkey belongs to a different website, so this page cannot use it." | The passkey was made for another origin | none |
| "This browser or device cannot make the kind of passkey the registry needs. Try a browser with fingerprint or face unlock." | No WebAuthn, or no P-256 support | none |
| "The unlock did not finish. Your device said this:" | Anything else the ceremony threw, with the device's own message under it | none |
| "The signature from your device would be refused by the registry, so it was not sent. Try again, and use the same unlock you bound." | The browser checked the assertion against the bound key and it did not hold. Nothing was sent | "Try again" |

That last one is worth reading twice. The studio checks your signature the same way the contract
would, on your machine, before it spends anything. A signature the chain would reject never becomes
a transaction.

### When the registry refuses the transaction

Each of these is a named error from `MoolamRegistry`, decoded from the simulation rather than
guessed at.

| Message | Contract error | Button |
| --- | --- | --- |
| "This exact image is already registered. The first registration wins, so open the passport that holds it." | `PassportAlreadyExists` | "Open that passport" |
| "The hour that signature was good for has passed. Register the image again." | `SignatureExpired`. Signatures are good for one hour from the moment the browser builds them | "Try again" |
| "Monad says your account has no passkey on it. Bind this device's unlock, then register the image." | `PasskeyNotBound` | "Bind this device" |
| "The registry refused that signature. Sign again with the unlock you bound to this account." | `InvalidPasskeySignature` | "Try again" |
| "The registry refused that passkey. Bind this device's unlock again." | `InvalidPublicKey` | "Bind this device" |
| "The registry is paused, so nothing can be registered right now. Try again later." | `EnforcedPause` | none |
| "The image was signed for a different account than the one sending it. Reload the page and register again." | `InvalidCreator` | none |
| "The registry refused this passport. The error it gave is below." | `EmptyMetadataURI`, `InvalidExactHash`, `InvalidKind` or `InvalidFingerprintVersion` | none |
| "Monad refused this transaction. The error the contract gave is below." | Any other revert, with the name underneath | "Try again" |

### While sending

| Message | What happened | Button |
| --- | --- | --- |
| "Privy would not pay the network fee for this transaction. What it said is below. You can send the same transaction and pay the fee yourself." | Privy's sponsorship refused the send before it reached Monad | "Send it and pay the fee myself" |
| "You closed the confirmation, so nothing was sent." | You dismissed the wallet prompt | "Try again" |
| "This step did not finish. The network's own words are below. Try again in a moment." | The send threw for any other reason | "Try again" |
| "Your send was accepted and Monad has not shown it yet. It may still land, so nothing has been sent a second time. Open your account below to look, or ask Monad again." | 90 seconds passed with no passport on chain | "Ask Monad again" |
| "Something went wrong before anything was sent. The message is below." | Anything that threw before the send | "Try again" |

The last wait is deliberately not painted red. The step goes muted with a hollow marker, because a
send that has not been shown yet is not a send that failed, and the one thing the studio must never
do is invite a second send for a transaction that already landed. "Ask Monad again" reads the chain
and sends nothing.

## What the screen does not tell you

The studio never claims a step it did not run. A row only reads done once its answer is in hand,
the fee line stays a claim until a balance reading proves it, and the block number waits for the
index rather than being guessed. If a passport is on the screen, it is on Monad.
