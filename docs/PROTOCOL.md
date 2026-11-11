# LiveSeal protocol, version 1

This is the normative description of what is signed, how it is encoded and how
it is checked. The reference implementation is `core/src/`. Section numbers
are stable; an implementation that follows this document interoperates with
the reference.

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
| `face_box` | bstr(4) | `x, y, w, h` of the face in the digested frames, each in 1/256 of the frame width or height. All zero: no face found. |
| `digest` | bstr(1..64) | Content digest of the frames of period `period - 1` (section 6). |
| `challenge` | bstr(0) or bstr(3) | A challenge the sender issues to its peer (section 5), or empty. |

The signature is Ed25519 over

```
"LiveSeal statement v1\0" || CBOR(statement)
```

The **wire form** embedded in the video is the same array with the 64-byte
signature appended as an eighth element:

```
[ version, session, key_id, period, face_box, digest, challenge, signature ]
```

## 4. Channel frame

The wire form is wrapped for transmission:

```
data     = length(1) || wire || zero padding || CRC-32(4)
codeword = data || Reed-Solomon parity
```

* `length` is the number of wire bytes.
* The CRC-32 (IEEE 802.3, as in zlib) covers `length`, `wire` and the padding.
* Reed-Solomon is over GF(2^8) with primitive polynomial `0x11d`, generator
  element 2 and first consecutive root 2^0, systematic, shortened.
* Codeword length and parity count are fixed by the channel profile
  (section 7).

A receiver MUST treat a codeword that fails Reed-Solomon decoding, fails the
CRC, or has non-zero padding as "seal unreadable". Such a codeword MUST NOT
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

Specified in [the digest section of EVALUATION.md](EVALUATION.md) together
with the measurements that selected it; the reference implementation is
`core/src/digest.ts`.

## 7. Channel modulation

Specified in [the channel section of EVALUATION.md](EVALUATION.md) together
with the measurements that selected it; the reference implementation is
`core/src/modem.ts`.

## 8. Verification

For each period the verifier evaluates the following in order and stops at
the first rule that applies. "Amber" and "red" refer to the period outcome;
the badge rules follow in section 9.

| # | Condition | Outcome |
|---|---|---|
| 1 | No pilot pattern detected | amber `no-seal` |
| 2 | Pilots detected, frame not decodable (section 4) | amber `unreadable` |
| 3 | Wire bytes are not a well-formed statement | amber `malformed` |
| 4 | `version` is not 1 | amber `unsupported-version` |
| 5 | No pinned key has this `key_id` | amber `unknown-key` |
| 6 | The signature verifies under none of the pinned keys with this `key_id` | red `bad-signature` |
| 7 | The key is revoked | red `revoked-key` |
| 8 | Now is outside the key's validity dates (organisation keys) | red `expired-key` |
| 9 | A challenge is active and `session` is all zero | amber `awaiting-challenge` |
| 10 | A challenge is active and `session` differs from it | red `wrong-session` |
| 11 | `abs(now - (period + 1) * 2 s)` exceeds 30 s without a challenge, or 120 s with one | red `stale` |
| 12 | `period` is not greater than the last accepted period of this key | red `replayed` |
| 13 | Digest comparison says mismatch | red `content-mismatch` |
| 14 | Digest comparison says uncertain | amber `content-uncertain` |
| 15 | otherwise | `valid` |

Rules 6 to 8 are applied after the signature has been verified against the
candidate keys, so a statement can only be attributed to a key that actually
signed it. The last accepted period (rule 12) advances only for outcomes 14
and 15.

## 9. Badge

* **Green** after 2 consecutive `valid` outcomes from the same key. Any other
  outcome ends green immediately.
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

An organisation publishes `https://<host>/.well-known/liveseal.json`:

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
