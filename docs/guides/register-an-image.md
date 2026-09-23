---
title: Register an image
---

# Register an image

Everything the studio can be in, and everything it can say when a step does not finish. If you just
want the happy path, read [Your first passport](../getting-started/your-first-passport) instead.

The studio is at "Register an image" in the header, and it has two ways in. Upload a picture you
already have and it registers as a Captured passport with one signature, yours. Ask the generator
agent for one and it registers as a Generated passport with two, the agent's and yours, over the
same digest. Everything after the picture exists is the same code on both paths: the same prepare,
the same passkey check, the same send.

What the agent is, how its key is held and what its own page shows are in
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

## What a prompt has to be

| Limit | Value | Where it is enforced |
| --- | --- | --- |
| Prompt | 8 to 600 characters | The browser checks first, then the service refuses anything outside |
| Title | 1 to 120 characters | The same on both sides |
| How often | 3 pictures a day per signed-in account | The service, counted on the Privy user id from your token, over a rolling 24 hours |
| At once | 2 pictures being drawn across the whole service | The service. A fourth caller waits, and is told the agent is busy rather than held forever |

Three a day is about nine cents of image model spend per account, which is what keeps a public
button off the model bill. The count is held in the service's memory, so a redeploy hands everyone a
fresh day.

Nothing is added to what you type. The prompt is the only text that reaches the model, so nothing
the service says about itself can end up inside the manifest of a picture you then register in your
own name.

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

### The choice

Above both panels, headed "Two ways in": "Upload a picture", with "One you already made. Your unlock
signs it.", and "Make one with the agent", with "The agent draws it and signs it beside you." The
accent edge slides between the two, and the panel under them changes with the choice. Nothing is
sent by choosing.

### Ready to register

The upload panel. The card reads "Ready" over "Give an image its passport". Drop area, title field,
the statement about AI use, and "Register this image". Three step rows sit under the button and
light up in order.

### Saying how AI may use it

Both panels carry the same block, headed "Say how AI may use it" under "Before it is signed", with
one line on what becomes of the answer: "It goes inside the file before anything is signed, and onto
Monad the moment the passport is written. One statement, in two places that both hold."

Three plates: "Open to AI use", "Not for AI training" and "Ask me first". Under them, "answer use by
use" opens the four uses so each can be set on its own. "Ask me first" needs a conditions text, and
the counter under the box counts real bytes against the 256 the register keeps, not characters, so a
line break or an accented letter is refused with the position of the byte that has to go.

Saying nothing is a choice and the screen says so: "Saying nothing is a choice too, and it gives
nobody permission. You can state it later from the passport page." Nothing is sent in that case, and
no second transaction goes out.

Pick one and the words travel into the C2PA manifest the verify service signs into your file and
into the pinned metadata. After the passport is confirmed on chain, the studio sends a second
sponsored transaction writing the same words to the consent register, and confirms it by reading the
chain back.

### A private re-check of a sealed picture

Turn on "Keep this picture sealed" and a second switch appears straight under it, off every time the
form opens: "Let Chainlink re-check this privately". With it on, the verify service keeps one small
copy, 512 pixels on its longest side, on Pinata's private network, and the pinned file gains one
word, `privateRecheck`, which the list of what becomes public shows as its own row. Nobody can open
the copy from the web. Moolam's operator and Pinata can, and today the Chainlink workflow that reads
it runs in the simulator, which is not a real enclave. The receipt stamps "Private copy kept" only
when the service's answer says one was kept, and turning sealed off turns this off with it.

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

### The statement, on the receipt

The statement has its own small state beside the registration, because it is a second transaction
and it can end differently. The receipt stamp headed "How AI may use it" reads one of five ways.

| State | What the receipt says | What it means |
| --- | --- | --- |
| `idle` | nothing yet | The send has not started |
| `sending` | "Writing your statement", over "The same words that went into the file, now going to the consent register on Monad." | The second transaction is out |
| `unconfirmed` | "Sent, and Monad has not shown it yet", over "Nothing has been sent a second time. Ask Monad again in a moment." | With an "Ask Monad again" button that reads the chain and sends nothing |
| `stated` | "Stated on Monad in {ms} ms", with who paid the fee and your conditions if there were any | The register was read back and it holds the statement |
| `failed` | "Registered, statement not written", over "The passport is on chain. You can write the statement from its own page whenever you like." | With "Write the statement again" |

A creator who said nothing gets a stamp too: "Nothing stated about AI use", over "Silence is not
permission. You can state it from the passport page at any time."

The important rule is the one in the failed row. A statement that failed, or that you cancelled at
the wallet prompt, never undoes the registration. The passport is on chain and stays there. The
statement can be retried from the receipt or written later from the passport page, and until it is,
the passport reads as nothing stated.

## The agent path, state by state

The same account, the same passkey and the same send. What changes is where the picture comes from
and that a second signature has to be on the passport before the registry takes it.

### Ready to ask

"The agent" over "Let the agent draw it". A prompt box with a character counter, three example
prompts under "Or start from one of these", a title field, and "Make and register". The day's count
sits under the button as "0 of 3 today", and when it is spent the button is off and the line reads
"Today's pictures are used up." with the time the next one opens up.

### Drawing

"The agent is drawing this, up to sixty seconds". The plate beside the steps says the same thing,
and before that it reads "The picture appears here the moment the agent is done with it." The model
gets sixty seconds and is not retried past it.

Finishes as "Drawn by" and the model's name, with the picture on the plate.

### Pinning

"Pinning to IPFS". The picture, its thumbnail, the readable copy of the C2PA manifest and the
metadata go up, the same four files the upload path pins. Nothing has been signed yet, so a failure
here costs no gas.

Finishes as "Pinned to IPFS".

### The agent signs

"The agent is signing". The service asks Privy's enclave for the agent's EIP-712 signature over the
final pinned bytes. The agent's seal fills in with its id and the wallet that signed, under one
line: "Signed by a Privy server wallet under a policy that allows only this."

Finishes as "Signed by the agent".

### Waiting for the passkey

"Waiting for your passkey", over the same digest the agent just signed. Your seal fills in beside
the agent's.

Finishes as "Signed on this device".

### Sending

"Sending to Monad, network fee sponsored", then "Waiting for Monad to record the passport". The same
send, the same 90 second watch, the same simulation first.

Both signatures are good for thirty minutes from the moment the service builds the passport. The
window is that long because the agent signs as soon as the picture is pinned and a person may take a
minute deciding whether they want it. Past it the registry answers `SignatureExpired`.

### Generated

"An agent made this, and you both signed for it", with the kind, the agent that drew it, the model,
the title and the prompt, then links to the passport, "The agent's record", the transaction, your
account, the pinned image and "Make another".

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

### While the agent draws

The retry button on this path reads "Make it again" rather than "Try again", because trying again
here is not resending the same picture. It draws a new one and spends a slot from the day's count,
so the button says so.

| Message | What happened | Button |
| --- | --- | --- |
| "Write a few more words. The agent needs at least eight characters to draw from." | The browser checked the prompt before spending a request | none |
| "That prompt is longer than 600 characters. Shorten it and ask again." | The same check, at the other end | none |
| "You have had every picture the agent draws for one account in a day. The count under the button says when the next one opens up." | The service answered 429 on the daily cap | none |
| "The model would not draw this prompt. Its own reason is below. Edit the prompt and ask again." | The model's safety system turned the prompt down, a 400. Its own words are printed underneath | none |
| "The model did not finish this picture. It may have drawn before it failed, so that one still counts against today's total." | A 502 after the request went out | "Make it again" |
| "The image could not be pinned to IPFS, so nothing was registered. Try again in a moment." | Pinata refused a pin, so the service answered 502 | "Make it again" |
| "The picture was drawn and pinned, and the agent's wallet would not sign the passport. Try again. If it keeps happening, the policy on the agent's wallet is the likely cause." | The service could not get the agent's signature out of Privy's enclave, a 502 | "Make it again" |
| "The agent is already drawing as many pictures as it can at once. Try again in a minute." | Two pictures were already being drawn and no slot came free, a 503 | "Make it again" |

Which of these cost you one of the day's three is worth saying plainly. A prompt the model refused
and a request that never got a drawing slot both hand the count back, because nothing was drawn. A
model that failed part way keeps it, and so do a failed pin and a failed agent signature, because by
then the picture had been drawn and billed. The two length checks never reach the service at all.

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
| "The hour that signature was good for has passed. Register the image again." | `SignatureExpired`. An upload's signature is good for one hour from the moment the browser builds it, and a generated one for thirty minutes from the moment the service does | "Try again" |
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
