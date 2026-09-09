---
title: Your first passport
sidebar_label: Your first passport
sidebar_position: 3
---

# Your first passport

One setup step, then three steps per image. This page walks all of them slowly, with the wait each
one shows and what to do when one does not finish.

## What a passkey is here

A passkey is the fingerprint reader, face unlock or PIN your device already uses to unlock itself.
The studio says it in one line: "A passkey is the fingerprint, face unlock or PIN this device
already uses. It stays on the device: Moolam only ever sees the public half."

The private half is made inside your device's secure hardware and never leaves it. Moolam is not
told it, Privy is not told it, and it does not travel over the network. What goes on chain is the
public half, two 32 byte numbers, stored against your account by the registry. Every image you
register is signed by the private half on your device, and the registry checks that signature
itself against Monad's P-256 precompile before it writes anything.

That is the difference between a passport and a caption. Nobody can add your name to an image
later, because the signature covers the image fingerprint and it happens on your hardware.

## The one-time bind

The first time you open the studio with a new account, the card reads "One setup step" over "Link
this device to your account", and explains why: "Your account has no signature on it yet. Bind the
unlock on this device once and it becomes the signature on every image you register."

Press "Use this device's unlock". Four things happen, and each one prints its own line while it
runs:

| Line on screen | What is happening |
| --- | --- |
| "Making a passkey on this device" | Your browser asks the device to create a P-256 passkey. The device prompts you once |
| "Waiting for your fingerprint or face unlock" | The new passkey signs the bind message, so the chain can see the key really is on this device. The device prompts you a second time |
| "Sending it to Monad, network fee sponsored" | The transaction goes out, with the fee paid by Moolam |
| "Waiting for Monad to record your passkey" | The studio watches the registry until the bind lands |

When it lands the card reads "Bound" over "This device now signs for your account. Register an
image and it will ask for your unlock once.", with a link to the transaction on MonadVision.

Two prompts, not one, because binding proves ownership rather than asserting it. The registry makes
your account prove it holds the key by signing a bind digest with it, and it consumes a nonce, so
the same signed bind can never be replayed. The rules are in the
[trust model](../concepts/trust-model).

## Registering an image

Drop a picture on "Drop an image here" or press "Choose a file". JPEG, PNG or WebP, up to 20 MB.
Give it a "Title": it goes into the C2PA manifest and the pinned metadata, so use the name you
would call the picture. Then press "Register this image".

Three steps run in order, and each one shows what it is waiting on.

**1. Prepare.** The line reads "Fingerprinting and pinning, about ten seconds". Your browser sends
the file to the Moolam verify service, which turns it the right way up, signs a C2PA manifest into
it, fingerprints those signed bytes, builds a thumbnail, and pins the image, the thumbnail, the
manifest and the metadata to IPFS. It finishes as "Fingerprinted, manifest embedded, pinned to
IPFS". Nothing has been sent to Monad yet, so a failure here costs no gas.

**2. Sign.** The line reads "Waiting for your fingerprint or face unlock". The studio reads the
EIP-712 digest from the registry itself, hands it to your passkey as the WebAuthn challenge, and
checks the assertion in the browser before spending anything. It finishes as "Signed on this
device".

**3. Send.** The line reads "Sending to Monad, network fee sponsored", then "Waiting for Monad to
record the passport" while the studio polls the registry once a second for up to 90 seconds. It
finishes as "Written to Monad".

The card then turns into "This image now has a passport" with the passport id, the block, the time,
who paid the fee, and four links: the passport page, the transaction, the pinned image and
"Register another image".

## The receipt

Down the right of the studio is a stub headed "What just happened", with one line under it: "Every
step gets stamped here as it lands. Nothing on this list is a guess."

Each stamp is a fact the studio actually established, in the order it happened: "Signed in", "Your
account on Monad", "Passkey bound", "Exact hash", "Pinned to IPFS", "Digest you signed", "Sent to
Monad", "Written to Monad". Nothing is stamped before its answer is in hand, which is why the block
number can arrive after the rest: it reads "Recorded. The block number comes from the index." until
the indexer catches up.

## Registering the same image twice

The passport id is the sha256 of the registered bytes, so the same file can only ever have one
record. A second attempt reverts on chain with `PassportAlreadyExists`, and the studio prints:
"This exact image is already registered. The first registration wins, so open the passport that
holds it.", with a button, "Open that passport".

That is the rule Moolam is built on, and it is stated narrowly on purpose. A passport proves who
registered first, not who drew the picture. The [trust model](../concepts/trust-model) says what
that does and does not settle.

## When your passkey is on another device

A passkey lives on one device. Open the studio on a second browser or a second laptop and the chain
already says your account has a key bound, which this browser has never seen. That is normal, and
the studio treats it as normal: the card reads "Another device signed here" over "Your passkey was
set up somewhere else".

You have two ways forward.

**Unlock with the passkey you already have.** Press "Unlock with my passkey". If the passkey is
synced to this device through your password manager or platform account, the prompt offers it, the
browser checks the answer against the key the chain already holds, and you carry on. This costs no
transaction and changes nothing on chain.

**Bind this device instead.** Press "Bind this device instead" and this device's unlock becomes the
new signature on your account. The screen is plain about the cost: "If that passkey lives on your
phone or another laptop, open Moolam there, or bind this device instead. Binding replaces the old
one and costs one transaction."

Rebinding replaces the key for images you register from now on. Passports you already registered
keep the signatures they were written with, permanently.

## When a send does not come back

Privy's sponsored path can answer a send with an empty transaction hash while the transaction is
already on its way, so the studio never decides a send failed because a hash was missing. It
watches the registry itself: the bind nonce moving, or the passport existing.

If 90 seconds pass with neither, the step goes muted rather than red and says: "Your send was
accepted and Monad has not shown it yet. It may still land, so nothing has been sent a second time.
Open your account below to look, or ask Monad again." The two things offered are a link to your
account on MonadVision and a button, "Ask Monad again", which reads the chain again and sends
nothing.

Every failure the studio can show, and what to do about each, is listed in
[Register an image](../guides/register-an-image).
