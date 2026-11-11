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
   runs real video codecs. Three early guesses were overturned by the data:
   Reed-Solomon lost to a soft-decision code, luma alone lost to three planes,
   and a DCT hash lost to a gradient hash. EVALUATION.md has the numbers.
5. **Say what is not proven.** The limits are listed in section 10 and in the
   README, next to every claim.

## 3. Components

| Folder | What it is |
|---|---|
| `core/` | Pure TypeScript, no DOM. Protocol, CBOR, Ed25519, error-correcting codes, the modem maths, the digest, contacts, revocation, the verification state machine, and the sender and receiver sessions. Unit-tested with Node's built-in test runner. |
| `codec-sim/` | Headless channel simulator. Pushes sealed video through real VP8, VP9, H.264 and AV1 encoders (ffmpeg) and feeds the result to the real `core/` receiver. Also holds the digest research, the attack suite and the script that builds the tables in EVALUATION.md. |
| `shared/` | Browser glue used by more than one app: WebGL sealing shader, camera and video pipelines, Insertable Streams sealer, worker verifier, key storage, badge, pairing panel. |
| `sender/` | LiveSeal Camera, a PWA that seals the webcam for use with a virtual camera. |
| `extension/` | Manifest V3 extension. Seals `getUserMedia` on web call apps and badges incoming `<video>` tiles. |
| `verifier/` | "Verify a screen" (phone camera or window capture) and the recording checker. |
| `lab/` | A sealed call in one page, through a real `RTCPeerConnection` pair, with attack buttons. Also the tool behind the browser loop-back measurements. |
| `abtest/` | Blind A/B page for the visibility question. |
| `demo-bank/` | Static demo organisation that publishes `.well-known/liveseal.json`. |

The signal processing lives in `core/` so that the simulator, the tests and the
browser all run the same code. The WebGL shader that embeds the seal has a CPU
twin in `core/` with the same formulas; the simulator uses the twin. The
complete logic of a sealed stream is in two classes, `SenderSession` and
`ReceiverSession`; the browser apps and the attack suite both drive those.

## 4. Identity and keys

* Each user has one Ed25519 key pair, created by WebCrypto as a
  non-extractable key and stored as a `CryptoKey` object in IndexedDB. The raw
  private key is never visible to page script. Browsers without Ed25519 in
  WebCrypto fall back to a software key kept in IndexedDB, and the UI shows a
  clear warning for as long as that key is in use.
* **Contacts** are pinned public keys. Pairing is an in-person QR exchange or a
  safety number compared over another channel. A changed key is never accepted
  silently: the user is warned and has to confirm the replacement.
* **Organisations** publish their keys at
  `https://<domain>/.well-known/liveseal.json`. The verifier fetches that file
  over HTTPS when the user adds the organisation, pins the listed keys under
  the domain name and refreshes them to pick up revocations. The name shown on
  a green badge is the address that served the file, never a name supplied by
  the caller.
* **Revocation** is a statement signed by the key being revoked. Contacts
  import it; organisations list revoked keys in their JSON file. A revoked key
  can never produce green again.

The identity shown on screen comes only from the verifier's own contact list.
A valid seal from an unknown key is reported as "sealed by a key you have not
verified" and stays amber.

## 5. The statement

Once per seal period (2 seconds) the sender signs:

| Field | Bytes | Purpose |
|---|---|---|
| version | 1 | Protocol version. |
| session | 3 | The verifier's challenge, or zero when no challenge is active. |
| key id | 4 | First bytes of a hash of the public key; tells the verifier which pinned key to try. |
| period | 5 | Index of the 2-second period on the sender's clock. It is the timestamp and the replay counter in one. |
| face box | 4 | Where the sender's face detector found the face, in frame-relative units. |
| digest | 32 | Robust digest of the pictures of the previous two seconds. |
| challenge | 0 or 3 | A challenge the sender issues to its peer. |
| signature | 64 | Ed25519 over all of the above with a domain-separation prefix. |

The signed bytes are a deterministic CBOR array; the whole statement is about
125 bytes on the wire. PROTOCOL.md gives the exact encoding.

### A note on the size of the problem

The signature alone is 512 bits, so a statement every 2 seconds needs about
500 payload bits per second. That is far more than the tens of bits per second
that classic invisible watermarks carry, and it shaped the whole channel:
large cells, three planes, slow symbols and a rate-1/5 error-correcting code.
Signing less often would shrink the rate but push the first green badge well
beyond 5 seconds, so the period stays at 2 seconds.

## 6. The robust content digest

The digest is what stops a valid seal from being pasted onto other pictures.
It has two opposing jobs: stay the same when the genuine video goes through a
harsh call codec, and change when the face or the frames are replaced.

* **Common reduction.** Both sides first reduce every frame to a fixed
  320 x 180 luma image. Everything else works on that reduction, which makes
  the digest independent of the resolution the call platform delivers.
* **The sender signs the face position.** The sender locates the face with an
  on-device detector (MediaPipe, WASM) and puts the box into the signed
  statement. The verifier uses the signed box and needs no detector of its
  own. Without a detector the sender signs a fixed central box.
* **Several snapshots per period.** The two seconds are cut into eight short
  moments. Four of them contribute a face hash and two a whole-frame hash, so
  the digest also binds how the picture changes over time.
* **Gradient hash, weighted.** Each face snapshot is cropped to 32 x 32,
  normalised, averaged into a 6 x 6 grid, and the signs of 48 differences
  between neighbouring blocks are kept. When comparing, each bit counts in
  proportion to how far the receiver's own value is from zero, because a
  value near zero flips under the slightest noise. This was the best of four
  hash families in the measurements.
* **Three verdicts.** Match, uncertain, mismatch. Only "match" can lead to
  green. A single mismatch is treated as uncertain; two in a row are red.
  The thresholds sit between the largest genuine distance ever measured
  (0.044) and the smallest distance of a replaced face (0.106).

## 7. The hidden channel

The statement has to reach the other side inside the pixels and survive a
codec that throws away almost everything it considers invisible.

* **Large cells.** The frame is a 32 x 18 grid. Each cell is shifted up or
  down by a small amount. A uniform shift of a whole block is the cheapest
  thing for a block-transform codec to keep.
* **Three planes.** Luma and both colour-difference planes carry independent
  patterns. This turned out to be essential: the temporal denoiser that
  real-time VP8 encoders run removes small luma steps almost completely and
  leaves colour steps largely alone.
* **Slow symbols.** A cell keeps its value for a quarter of a second, with a
  short cross-fade into the next value.
* **Differential signalling in time.** Every bit is an up/down or down/up
  pair in the same cell. The receiver subtracts the two halves, which removes
  the picture wherever the picture is not moving. (It also means a moving
  camera breaks the channel; see section 10.)
* **Pilot cells.** One cell in eight carries a fixed public sequence. The
  receiver uses the pilots to find the timing, to decide whether a seal is
  present at all, and to measure, plane by plane, how much of the pattern
  actually arrived. A plane the encoder has flattened gets no say in decoding.
* **Error correction.** A repeat-accumulate LDPC code at rate about 1/5 with
  soft decisions and a bit interleaver. A moving head corrupts a patch of
  cells; the interleaver spreads that damage and the decoder is told which
  bits to distrust. A CRC over the decoded bytes guards against a wrong
  correction before any signature is checked.

A decoded frame that fails its CRC is "no readable seal", never tampering.
Red is reserved for statements that decode cleanly and then fail a
cryptographic or content check.

## 8. Liveness challenge

When the receiving user presses Verify, the verifier creates a random
challenge and shows it as three words. If the verifier's own device also runs
LiveSeal, the challenge travels automatically inside its own outgoing seal;
otherwise the user reads the words out and the caller types them. The caller's
next statements carry the challenge in the signed session field.

The challenge proves the seal was made after the button was pressed and for
this call. It does not, on its own, defeat an attacker who relays everything
in both directions; content binding does that, and the remaining gap is
described in THREAT_MODEL.md (T3).

## 9. Verification and the badge

For every seal period the verifier runs the checks in a fixed order and stops
at the first failure: pilots found, frame decoded, key pinned, signature,
key not revoked or expired, session, freshness, replay, content.

* **Green** after two validly signed statements in a row from the same key,
  the newest of which has also had its pictures compared. Green drops on the
  first period that is not fully valid. In steady state every statement
  behind a green badge has been content-checked; only the very first
  statement a verifier sees can be unchecked, because its pictures predate
  the verifier.
* **Amber** when no seal is found, the seal is unreadable, the key is unknown
  or the content comparison is uncertain. If the call was green earlier, or
  the contact normally seals their calls, amber is a strong warning.
* **Red** when a statement decodes cleanly and then fails the signature,
  session, freshness or content check. Red is held for several periods so
  that an attacker cannot make it vanish by simply dropping the seal.

Because one statement is needed to start and one to confirm, the first green
comes 4 to 6 seconds after a verifier begins to watch a sealed stream.

Badge state is also announced through an ARIA live region, uses three
different shapes as well as three colours, and always carries a text label.

## 10. Limits of the design

These are consequences of the design, not bugs to be fixed later.

* **The seal covers the picture, not the sound.** A real sealed video with a
  cloned voice dubbed over it stays green.
* **The digest is a low-resolution fingerprint.** It binds what the face looks
  like on a 6 x 6 grid, four times in two seconds. An edit smaller than that,
  and smaller than what the codec itself changes, is not caught. In the
  measurements a mouth-only edit passed about nine times in ten.
* **The digest function is public.** An attacker who holds a live genuine
  sealed stream can try to craft frames that keep the digest while changing
  the content. The tolerance is narrow, but it is a tolerance and not a
  cryptographic bound.
* **A moving camera breaks the channel.** The receiver cancels the picture by
  subtracting consecutive slots. Hand-held callers will mostly be "not
  verified" in this version.
* **The seal proves a key and a device, not a person.** A stolen unlocked
  device, or a key holder who points the camera at a screen, produces valid
  seals.
* **No seal means no information.** LiveSeal can never say that an unsealed
  call is fake, only that it is unverified.
