# LiveSeal protocol, version 1

This is the normative description of what is signed, how it is encoded, how it
travels in the picture and how it is checked. The reference implementation is
`core/src/`. Where a procedure is too long to restate (the pseudo-random
tables and the parity-check matrix), the reference code is normative and this
document gives checksums and a test vector (section 12).

All multi-byte integers are big-endian. "CBOR" means RFC 8949 core
deterministic encoding restricted to unsigned integers, byte strings, text
strings and definite-length arrays. Decoders MUST reject any other encoding of
the same value (non-minimal integers, indefinite lengths, trailing bytes).

## 1. Keys and identifiers

* Signature scheme: Ed25519 (RFC 8032). Public keys are the raw 32 bytes.
* Key id: the first 4 bytes of `SHA-256("LiveSeal key id v1\0" || public_key)`.
* Fingerprint (for display): the first 16 bytes of
  `SHA-256("LiveSeal fingerprint v1\0" || public_key)` as 8 groups of 4 hex
  digits.
* Safety number of two keys: sort the two public keys bytewise, compute
  `h = "LiveSeal safety number v1\0" || first || second`, apply SHA-256 2048
  times, and print 6 groups of 5 decimal digits, where group `g` is the 40-bit
  integer at bytes `5g .. 5g+4` modulo 100000.

## 2. Time

A **seal period** lasts 2000 ms. The period index of a moment is
`floor(unix_ms / 2000)` on the sender's clock. One statement is transmitted
per period. The index doubles as timestamp and replay counter.

## 3. Statement

A statement is the CBOR array

```
[ version, session, key_id, period, face_box, digest, challenge ]
```

| Field | Type | Meaning |
|---|---|---|
| `version` | uint | `1` |
| `session` | bstr(3) | The challenge this seal answers. All zero: none. |
| `key_id` | bstr(4) | Key id of the signing key (section 1). |
| `period` | uint, < 2^32 | Index of the period in which the statement is transmitted. |
| `face_box` | bstr(4) | `x, y, w, h` of the face in the digested frames, each in 1/256 of the frame width or height. |
| `digest` | bstr(32) | Content digest (section 6) of the 2 seconds that end 250 ms before the period starts. |
| `challenge` | bstr(0) or bstr(3) | A challenge the sender issues to its peer (section 5), or empty. |

The signature is Ed25519 over

```
"LiveSeal statement v1\0" || CBOR(statement)
```

The **wire form** embedded in the video is the same array with the 64-byte
signature appended as an eighth element. It is 122 bytes without a challenge
and 125 with one.

## 4. Channel frame and error correction

```
data  = length(1) || wire || zero padding || CRC-32(4)        exactly 144 bytes
```

* `length` is the number of wire bytes.
* The CRC-32 (IEEE 802.3, as in zlib) covers `length`, `wire` and the padding.
* A period with no statement to send carries a frame with `length` 0.

The 1152 data bits (most significant bit of each byte first) are encoded with
a systematic repeat-accumulate LDPC code into 6048 bits:

* Parity-check matrix `H = [A | D]` with 4896 checks. `D` is dual-diagonal:
  check `i` contains parity bits `i` and `i - 1`. `A` has 4 ones per column,
  placed by the deterministic procedure `makeLdpc(6048, 1152, 0x1d9c, 4)` in
  `core/src/ldpc.ts`.
* Encoding: `s = A * u`, then `p[0] = s[0]`, `p[i] = p[i-1] xor s[i]`. The
  codeword is `u || p`.
* Interleaving: code bit `i` is sent as channel bit `perm[i]`, where `perm` is
  the Fisher-Yates shuffle of `0..6047` driven by the generator of section 7.4
  seeded with `0x1e4f` (`j = next() mod (i + 1)` for `i` from 6047 down to 1).

A receiver MUST treat a frame that does not decode to a valid codeword, fails
the CRC, or has non-zero padding as "seal unreadable". Such a frame MUST NOT
be passed to the signature check.

## 5. Challenge

A challenge is 3 random bytes, never all zero. It is displayed as three words:
byte value `b` maps to entry `b` of the 256-word list in `core/src/words.ts`.

* A verifier with an active challenge accepts only statements whose `session`
  equals the challenge.
* A sender learns a challenge either from user input (the three words) or
  from the `challenge` field of a statement it has itself verified in the
  incoming video. It then sets `session` to that value in its following
  statements.
* A sender that wants to challenge its peer puts the value in the `challenge`
  field of its own statements.

The challenge is not a secret and 24 bits are enough for its purpose: it only
has to be unpredictable before the Verify button is pressed. Recordings are
additionally rejected by the freshness rule in section 8.

## 6. Content digest

### 6.1 Input

Every frame is reduced to a 320 x 180 luma image by area averaging (luma is
`0.299 R + 0.587 G + 0.114 B` when the source is RGB). Both ends keep these
reduced frames with their times.

For the statement transmitted in the period that starts at `S` (ms), the
digest window starts at `W = S - 2250`. It holds 8 **snapshots**; snapshot `s`
is centred at `W + (s + 0.5) * 250` and is the average of all reduced frames
within 55 ms of that centre, or the nearest frame if it lies within 130 ms.

### 6.2 Face hash (snapshots 0, 2, 4, 6; 48 bits each)

1. Convert the face box to pixels of the reduced image: multiply by 320/256
   and 180/256, round, force width and height to at least 8, clamp to the
   image.
2. Resample the box to 32 x 32 by area averaging.
3. Subtract the mean; divide by `sqrt(variance + 1)`.
4. Average into a 6 x 6 grid of blocks: pixel `(x, y)` belongs to block
   `(floor(6x/32), floor(6y/32))`.
5. Emit features in this order until 48 are produced: for `y` in 0..5, for
   `x` in 0..4: `b[y][x+1] - b[y][x]`, then (if `y < 5`) `b[y+1][x] - b[y][x]`.
6. A bit is 1 where the feature is positive.

### 6.3 Frame hash (snapshots 1, 5; 32 bits each)

1. Reduce the snapshot to 64 x 36 by area averaging, then to a 16 x 16 grid of
   block means as in step 4 above.
2. Normalise as in step 3.
3. Take the two-dimensional DCT-II and keep the 32 lowest-frequency
   coefficients other than DC, ordered by `u + v` ascending and then `u`
   ascending (`u` vertical).
4. A bit is 1 where the coefficient is positive.

### 6.4 Layout and comparison

The digest is the 4 face hashes followed by the 2 frame hashes, most
significant bit first: 32 bytes.

The verifier computes the same features from the frames it received and, for
each hash, the **weighted distance**: with `r` the root mean square of its own
features, feature `i` has weight `min(1, |f_i| / (0.5 r))`; the distance is
the weight of the disagreeing bits divided by the total weight. Distances are
averaged over the snapshots of each kind. A snapshot whose crop (face) or
thumbnail (frame) has a standard deviation below 5 levels is left out: there
is nothing in it to compare.

| Verdict | Condition |
|---|---|
| mismatch | face distance >= 0.085 or frame distance >= 0.12 |
| match | face distance <= 0.055 and frame distance <= 0.05 and mean face weight >= 0.5 |
| unobserved | none of the snapshots has a frame (the window predates the verifier) |
| uncertain | anything else, including fewer than 2 usable face snapshots |

## 7. Channel modulation

### 7.1 Grid, planes and time

* The picture is a grid of 32 x 18 cells, in each of three planes: Y, Cb, Cr
  (BT.601). Cell `(x, y)` of plane `p` has index `p * 576 + y * 32 + x`.
* A period has 8 slots of 250 ms. During a slot every cell is offset by
  `+a` or `-a`, where `a` is the plane's amplitude in 8-bit limited-range
  units: 2 for Y and 3 for Cb and Cr ("light": 1.5 and 2).
* At the start of a slot the offset cross-fades from the previous slot's
  value over 34 ms with `3t^2 - 2t^3`.
* Within a cell the offset is constant except for the outer 10% on each side,
  where it blends into the neighbouring cell with the same curve.

### 7.2 Pilots and data cells

Cell `(x, y)` of plane `p` is a **pilot** when `(x + 3y + 3p) mod 8 = 0`;
there are 216. All other cells are **data cells**, 1512 in total, taken plane
by plane and row by row, with odd rows right to left.

### 7.3 Bit mapping

Channel bit `i` (section 4) travels in data cell `floor(i / 4)` as slot pair
`i mod 4`, that is slots `2 (i mod 4)` and `2 (i mod 4) + 1`. With
`b = bit xor scramble[i]`: `b = 0` is sent as `(+a, -a)` and `b = 1` as
`(-a, +a)`.

### 7.4 Public pseudo-random tables

Generator: 32-bit xorshift, `x ^= x << 13; x ^= x >>> 17; x ^= x << 5`, each
step truncated to 32 bits; `next()` returns the new `x`.

Seeded with `0x4c535031`:

1. For each pilot in cell order: start from `[+1, +1, +1, +1, -1, -1, -1, -1]`
   and shuffle with `j = next() mod (i + 1)` for `i` from 7 down to 1. The
   result is that pilot's sign in slots 0..7.
2. Then for each of the 6048 channel bits in order:
   `scramble[i] = (next() >>> 7) & 1`.

### 7.5 Receiver (informative)

The reference receiver averages the centre of every cell, searches for the
period start that maximises the correlation of the pilots with their
sequences (a seal is "present" at a mean correlation of 0.3 or more in the
best plane), estimates amplitude and noise per plane from the pilots, forms a
soft value for every bit from the difference of its two slots, and decodes
with belief propagation.

## 8. Verification

For each period the verifier evaluates the following in order and stops at
the first rule that applies.

| # | Condition | Outcome |
|---|---|---|
| 1 | No pilot pattern detected | amber `no-seal` |
| 2 | Pilots detected, frame not decodable (section 4) | amber `unreadable` |
| 3 | The frame is empty (`length` 0): the sender has no statement yet | amber `starting` |
| 3a | Wire bytes are not a well-formed statement | amber `malformed` |
| 4 | `version` is not 1 | amber `unsupported-version` |
| 5 | No pinned key has this `key_id` | amber `unknown-key` |
| 6 | The signature verifies under none of the pinned keys with this `key_id` | red `bad-signature` |
| 7 | The key is revoked | red `revoked-key` |
| 8 | Now is outside the key's validity dates (organisation keys) | red `expired-key` |
| 9 | A challenge is active and `session` is all zero | amber `awaiting-challenge` |
| 10 | A challenge is active and `session` differs from it | red `wrong-session` |
| 11 | `abs(now - (period + 1) * 2 s)` exceeds 30 s without a challenge, or 120 s with one | red `stale` |
| 12 | `period` is not greater than the last accepted period of this key | red `replayed` |
| 13 | Digest verdict is mismatch, for the second consecutive compared period of this key | red `content-mismatch` |
| 14 | Digest verdict is mismatch for the first time, or uncertain | amber `content-uncertain` |
| 15 | Digest verdict is unobserved | `valid`, content not checked |
| 16 | Digest verdict is match | `valid`, content checked |

Rules 7 and 8 are applied after the signature has been verified, so a
statement is only ever attributed to a key that signed it. The last accepted
period (rule 12) advances for outcomes 14 to 16. A match resets the mismatch
count of rule 13.

## 9. Badge

* **Green** after 2 consecutive `valid` outcomes from the same key, the latest
  of which is content-checked. Any other outcome ends green immediately.
* **Red** on any red outcome. Red is held until green is re-earned, or for 5
  further periods without a new red outcome, whichever comes first.
* **Amber** otherwise. Amber is flagged as a strong warning when the call was
  green earlier, or when the person the user expects on this tile normally
  seals their calls.

The identity shown on green is the name under which the verifier pinned the
key: the contact name chosen by the user, or the locator of the organisation
file (section 11). Names transmitted by the call platform are never shown as
verified.

## 10. Pairing and revocation codes

Both are text so that they fit in a QR code or a message.

```
liveseal:pair:<base64url( CBOR([1, name, public_key]) )>
liveseal:revoke:<base64url( CBOR([1, public_key, signature]) )>
```

The revocation signature is Ed25519, by the key being revoked, over
`"LiveSeal revocation v1\0" || CBOR([1, public_key])`. A revocation has no
date and no expiry: once imported, the key is revoked for good.

A verifier that is asked to pin a key under a name that already has a
different active key MUST NOT replace it silently. It reports a key change
and waits for explicit confirmation.

## 11. Organisation key file

An organisation publishes `https://<host>/.well-known/liveseal.json`, served
with `Access-Control-Allow-Origin: *` so that verifiers on other origins can
read it:

```json
{
  "liveseal": 1,
  "name": "Example Bank",
  "keys": [
    { "publicKey": "<base64url>", "label": "Customer calls",
      "validFrom": "2026-01-01T00:00:00Z", "validTo": "2028-01-01T00:00:00Z" }
  ],
  "subKeys": [
    { "publicKey": "<base64url>", "label": "Agent 042", "issuer": "<base64url of a key above>",
      "validFrom": "...", "validTo": "...", "signature": "<base64url>" }
  ],
  "revoked": [
    { "publicKey": "<base64url>", "revokedAt": "2026-06-01T00:00:00Z" }
  ]
}
```

* Keys under `keys` are trusted because of where the file was fetched from.
* A sub-key is accepted only if `issuer` is one of `keys` and `signature` is a
  valid Ed25519 signature by the issuer over
  `"LiveSeal sub-key v1\0" || CBOR([issuer, publicKey, label, validFrom, validTo])`
  with the two dates as Unix seconds.
* Keys under `revoked` are remembered as revoked even if they are no longer
  listed elsewhere.
* The verifier fetches the file over HTTPS when the user adds the
  organisation, and again whenever its copy is older than 24 hours.
* The **locator** shown on the badge is the host that served the file. If the
  file is served from below a path (`host/some/path/.well-known/liveseal.json`)
  the locator is `host/some/path`, shown in full and marked as path-scoped:
  only a file at the root of a host proves control of that host.

## 12. Checksums and test vector

Each checksum is the first 8 bytes of the SHA-256 of the table stored as
little-endian 32-bit integers (pilot cells, data cells, LDPC check lists) or
as one byte per entry (pilot signs as signed bytes, scramble bits, frame
bits). `core/test/vectors.test.ts` checks all of them.

| Table | Entries | Checksum |
|---|---|---|
| Pilot cell indexes | 216 | `b47df07fe405e751` |
| Pilot signs (pilot x slot) | 1728 | `5fdd631c6d03115e` |
| Data cell indexes | 1512 | `f3045ab9c23baa18` |
| Scramble bits | 6048 | `8d2808179d83f886` |
| LDPC: the 4 checks of each data bit | 4608 | `82413590e29a32e8` |
| Channel bits of a frame with `length` 0 | 6048 | `cdbd1f8158b6858d` |

Statement test vector. Secret key: 32 bytes of `0x07`. Public key
`ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c`, key id
`c1c3dc95`. Fields: version 1, session `010203`, period 900000000, face box
`4d1f669a`, digest bytes `d[i] = (7 i) mod 256` for `i` in 0..31, no
challenge. Wire form (122 bytes):

```
88014301020344c1c3dc951a35a4e900444d1f669a582000070e151c232a31383f464d54
5b626970777e858c939aa1a8afb6bdc4cbd2d9405840c52780e78c3eb75a3019e8629bc0
7bf116342dbcc0db85ac0e2f375b238b09df8857eeced354694cc51f55d04a20972f94b6
434d358bb9daf1e37e660a3e4200
```

Channel bits of that frame: checksum `04521ef9a97071c9`.
