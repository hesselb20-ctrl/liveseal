# LiveSeal design

This document explains how LiveSeal is put together and why. The wire format is
specified in [PROTOCOL.md](PROTOCOL.md), the attacks it is designed against are
in [THREAT_MODEL.md](THREAT_MODEL.md), and every number quoted here comes from
[EVALUATION.md](EVALUATION.md).

## 1. What LiveSeal does

The caller's device hides a signed statement inside its outgoing video. The
statement says: "this key, at this moment, in this call, sent these pictures".
The receiving device reads the statement back out of the pixels it is shown,
checks the signature against a key the receiver already trusts, and compares
the pictures it actually received with the pictures that were signed.

```
 caller                                               receiver
 ------                                               --------
 camera ─► digest of the last 2 s ─► sign ─┐
   │                                       ▼
   └────────────► embed statement in the pixels ─► any call app ─► codec ─► network
                                                                               │
              badge ◄─ state machine ◄─ checks ◄─ decode statement ◄─ pixels ◄─┘
                                          ▲
                        digest of the pictures actually received
```

LiveSeal does not try to detect fakes. It proves the real thing, and treats
everything it cannot prove as unverified.

## 2. Design rules

1. **A false green is the one failure that must never happen.** Every choice
   is made for zero false greens first and for fewer missed verifications
   second. Anything uncertain is amber.
2. **Everything is checked on the device.** No server, no account, no
   telemetry. Frames never leave the page that processes them.
3. **Platform independence.** The seal travels in the pixels, so it works
   through any call product that carries video.
4. **Measure, then choose.** The two hard parts (the content digest and the
   hidden channel) were chosen from several candidates using a simulator that
   runs real video codecs. See EVALUATION.md for the candidates that lost.
5. **Say what is not proven.** The limits are listed in section 10 and in the
   README, next to every claim.

## 3. Components

| Folder | What it is |
|---|---|
| `core/` | Pure TypeScript, no DOM. Protocol, CBOR, Ed25519, Reed-Solomon, the modem maths, the digest, contacts, revocation and the verification state machine. Unit-tested with Node's built-in test runner. |
| `codec-sim/` | Headless channel simulator. Pushes sealed video through real VP8, VP9, H.264 and AV1 encoders (ffmpeg) and feeds the result to the real `core/` receiver. Also holds the digest research and the attack suite. |
| `shared/` | Browser glue used by more than one app: frame pump, WebGL sealing shader, key storage, UI pieces. |
| `sender/` | LiveSeal Camera, a PWA that seals the webcam and outputs a sealed stream. |
| `extension/` | Manifest V3 extension. Seals `getUserMedia` on web call apps and badges incoming `<video>` tiles. |
| `verifier/` | Phone-mode PWA (point a phone at a screen) and the recording checker. |
| `demo-bank/` | Static demo organisation that publishes `.well-known/liveseal.json`. |

The signal processing lives in `core/` so that the simulator, the tests and the
browser all run the same code. The WebGL shader that embeds the seal has a CPU
twin in `core/` with the same formulas; the simulator uses the twin.

## 4. Identity and keys

* Each user has one Ed25519 key pair, generated with WebCrypto as a
  non-extractable key and stored as a `CryptoKey` object in IndexedDB. The raw
  private key is never visible to page script. Browsers without Ed25519 in
  WebCrypto fall back to a software key kept in IndexedDB, and the UI shows a
  clear warning for as long as that key is in use.
* **Contacts** are pinned public keys. Pairing is an in-person QR exchange or a
  safety number compared over another channel. A changed key is never accepted
  silently: the contact drops to "key changed" until the user re-pairs.
* **Organisations** publish their keys at
  `https://<domain>/.well-known/liveseal.json`. The verifier fetches that file
  over HTTPS when the user adds the organisation, pins the listed keys under
  the domain name and refreshes them to pick up revocations. The name shown on
  a green badge is the domain that served the file, never a name supplied by
  the caller.
* **Revocation** is a statement signed by the key being revoked (or by the
  organisation's root key for sub-keys). Contacts import it; organisations list
  it in their JSON file. A revoked key can never produce green again.

The identity shown on screen comes only from the verifier's own contact list.
A valid seal from an unknown key is reported as "sealed by a key you have not
verified" and stays amber.

## 5. The statement

Once per seal period (2 seconds) the sender signs:

| Field | Size | Purpose |
|---|---|---|
| version | 1 | Protocol version. |
| session | 3 | The verifier's challenge, or zero when no challenge is active. |
| key id | 4 | First bytes of a hash of the public key; tells the verifier which pinned key to try. |
| timestamp | 4 | Sender clock, Unix seconds. |
| counter | 2+ | Period counter; must increase by exactly one per period. |
| face box | 4 | Where the sender's face detector found the face, in frame-relative units. |
| digest | see 6 | Robust digest of the frames of the previous period. |
| signature | 64 | Ed25519 over all of the above with a domain-separation prefix. |

The signed bytes are a deterministic CBOR array. PROTOCOL.md gives the exact
encoding.

### A note on the size of the problem

The signature alone is 512 bits, so a statement every 2 seconds needs roughly
450 to 500 payload bits per second after framing. That is far more than the
"tens of bits per second" that classic invisible watermarks carry, and it is
the reason the hidden channel (section 7) uses large regions, slow symbols and
heavy error correction instead of a conventional spread-spectrum mark. Signing
less often would shrink the rate but push the time to a first green badge
beyond the 5 second target, so the period stays at 2 seconds and the channel
was designed to meet that rate.

## 6. The robust content digest

The digest is what stops a valid seal from being pasted onto other pictures.
It has two opposing jobs: stay the same when the genuine video goes through a
harsh call codec, and change when the face or the frames are replaced.

Design decisions:

* **Common reduction.** Both sides first reduce every frame to a fixed
  320 x 180 luma image by area averaging. Everything else works on that
  reduction, which makes the digest independent of the resolution the call
  platform happens to deliver.
* **The sender signs the face position.** The sender locates the face with an
  on-device detector and puts the box into the signed statement. The verifier
  uses the signed box and needs no face detector of its own. Moving the face,
  replacing it, or adding another face changes the pixels inside or around the
  signed box and therefore the digest.
* **Several snapshots per period.** A single average over two seconds would
  let an attacker change individual moments. The period is cut into short
  windows and each window contributes its own face hash, so the digest also
  binds how the face changes over time.
* **Two scales.** A fine hash of the face region and a coarse hash of the
  whole frame. The whole-frame part catches a replaced scene or a second face
  outside the signed box.
* **Three verdicts, not two.** Comparing the received digest with the signed
  one yields match, uncertain or mismatch. Only "match" can lead to green and
  only "mismatch" leads to red; the band in between is amber. The two
  thresholds were set from measured distributions (EVALUATION.md, section 3).

Candidates that were built and measured: DCT-sign perceptual hash, gradient
(difference) hash, quantised block means and random-projection hash, each at
the same bit budget. The winner and the reasons are recorded in EVALUATION.md.

What the digest cannot do is listed plainly in section 10.

## 7. The hidden channel

The statement has to reach the other side inside the pixels and survive a
codec that throws away almost everything it considers invisible.

* **Large cells.** The frame is divided into a grid of cells. Each cell is
  raised or lowered in brightness by a small amount. A uniform shift of a
  whole block is the cheapest thing for a block-transform codec to keep, and
  it is the hardest for a temporal denoiser to mistake for noise.
* **Slow symbols.** A cell keeps its value for a quarter of a second. Changes
  are cross-faded over a few frames and cell edges are smoothed, which keeps
  both the flicker and the edges below what a viewer notices (see the A/B test
  in EVALUATION.md, section 5).
* **Differential signalling in time.** Every data bit is sent as an up/down or
  down/up pair in the same cell. The receiver subtracts the two halves, which
  removes the picture content wherever the picture is not moving.
* **Pilot cells.** One cell in eight carries a fixed public sequence. The
  receiver uses the pilots to find the symbol timing, to decide whether a seal
  is present at all, and to estimate brightness drift.
* **Error correction.** The statement is protected by a Reed-Solomon code
  that fills the period. Bytes are mapped to neighbouring cells, so a moving
  head or hand wipes out a compact group of bytes; those are marked as
  erasures, which the code corrects twice as cheaply as unknown errors. A
  CRC over the decoded bytes guards against a wrong correction before any
  signature is checked.

The alternatives that were tried (chroma instead of luma, smaller cells,
shorter symbols, direct instead of differential signalling) and the reason
each lost are in EVALUATION.md, section 4.

A decoded statement that fails its CRC is treated as "no readable seal", never
as tampering. Red is reserved for statements that decode cleanly and then fail
a cryptographic or content check.

## 8. Liveness challenge

When the receiving user presses Verify, the verifier creates a random
challenge and shows it as three words. If the verifier's own device also runs
LiveSeal, the challenge travels automatically inside its own outgoing seal;
otherwise the user reads the words out and the caller types them. The caller's
next statements carry the challenge in the signed session field.

The challenge proves the seal was made after the button was pressed and for
this call. Together with the signed timestamp it defeats recordings. It does
not, on its own, defeat an attacker who relays everything in both directions;
content binding does that, and the remaining gap is described in
THREAT_MODEL.md (T3).

## 9. Verification and the badge

For every seal period the verifier runs the checks in a fixed order and stops
at the first failure:

1. pilots found (otherwise: no seal)
2. Reed-Solomon decode and CRC (otherwise: seal unreadable)
3. key id is a pinned, unrevoked key (otherwise: unknown or revoked key)
4. signature
5. session matches the active challenge
6. timestamp is fresh and the counter moves forward by one
7. digest matches the received frames

The state machine in `core/src/state.ts` turns the stream of per-period results
into a badge:

* **Green** only after N consecutive fully valid periods (N = 2), and it drops
  on the first period that is not fully valid.
* **Amber** when no seal is found, the seal is unreadable, the key is unknown
  or the content comparison is uncertain. If the contact normally seals their
  calls, amber is promoted to a strong warning.
* **Red** when a statement decodes cleanly and then fails the signature,
  session, freshness or content check. The reason is shown in plain words.

Badge state is also announced through an ARIA live region, uses a
colour-blind-safe palette with distinct shapes, and always carries a text
label.

## 10. Limits of the design

These are consequences of the design, not bugs to be fixed later.

* **The seal covers the picture, not the sound.** A real sealed video with a
  cloned voice dubbed over it stays green. Audio binding is future work.
* **The digest is a low-resolution fingerprint.** It binds what the picture
  looks like at roughly 32 x 32 pixels across the face, several times per
  period. An edit that is smaller than that, and smaller than what the codec
  itself changes, is not guaranteed to be caught. EVALUATION.md reports how
  small an edit has to be before it slips through.
* **The digest function is public.** An attacker who holds a live genuine
  sealed stream can try to craft frames that keep the digest while changing
  the content. The comparison is tuned so that such frames must look like the
  genuine frames at the digest's resolution, but this is a tolerance, not a
  cryptographic bound.
* **The seal proves a key and a device, not a soul.** A stolen unlocked
  device, or a key holder who points the camera at a screen, produces valid
  seals. Revocation limits the first; nothing in LiveSeal addresses the second.
* **No seal means no information.** LiveSeal can never say that an unsealed
  call is fake, only that it is unverified.
