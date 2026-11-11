# LiveSeal threat model

## What is being protected

A person receiving a video call wants to know whether the pictures on their
screen were sent, just now and for this call, by a device that holds a key
they have already decided to trust.

## Who the attacker is

The attacker can:

* run any face-swap or voice-clone model in real time;
* place calls from accounts with any display name and picture;
* record earlier genuine sealed calls made by the person being impersonated;
* call the genuine person at the same moment and capture that live sealed
  video (a relay);
* read this repository, so they know every algorithm and constant;
* re-encode, scale, crop, re-film or otherwise process video;
* generate their own LiveSeal keys and produce valid seals with them;
* talk to the victim and to the genuine person and try to mislead both.

The attacker cannot:

* obtain the genuine caller's private key (T6 covers what happens if they do);
* run code on the genuine caller's or the receiver's device.

## Attacks and how each is handled

Each row names the check that stops the attack and where that check is tested.
"Attack suite" refers to `codec-sim/run-attacks.ts`; measured results are in
EVALUATION.md, section 6.

### T1. Deepfake caller with no seal

*Outcome: amber, never green.*

Green needs a statement that verifies under a pinned key. With no statement
the pilot search finds nothing and the period is "no seal". Random video does
not produce pilots by chance: the detection threshold is set from the measured
score distribution of unsealed video through every codec in the simulator. If
the display name matches a contact who normally seals, the amber badge becomes
a strong warning (see T7).

### T2. Replay of a seal recorded from an earlier genuine call

*Outcome: red.*

Three independent checks fail:

* the signed period index, which is the sender's clock in 2-second steps, is
  outside the freshness window (30 seconds without a challenge);
* the signed session does not equal the challenge the verifier just issued;
* the period index is not greater than the last one the verifier accepted
  from that key.

The recorded pictures themselves would match their digest, so freshness and
session are the checks that matter here. The verifier reports "this seal was
made at another time or for another call".

### T3. Live relay: a genuine live seal pasted onto deepfake video

*Outcome: red.*

The attacker extracts the statement from the genuine stream and re-embeds it
in their own frames. The signature, timestamp and (if the attacker also relays
the challenge to the genuine person) the session are all valid. The digest is
not: it was computed from the genuine frames, the verifier computes it from
the frames it actually receives, and the two differ. The verifier reports "the
picture does not match what was sealed".

The first mismatching period is shown as amber and the second as red. The
delay of one period exists because a burst of bad picture quality on a
genuine call can produce a single mismatch; it gives the attacker nothing,
since neither state is green. In the attack suite every relay run with a
replaced face or person ended without a single green period (EVALUATION.md,
section 6.1).

What remains, stated honestly:

* **Pure relay of unmodified video.** If the attacker forwards the genuine
  video untouched, the victim sees the genuine person, live, and the badge is
  green. That is a correct statement about the picture. The danger is the
  context: the genuine person believes they are talking to someone else, and
  the sound is not sealed, so the attacker can replace the audio. LiveSeal
  does not stop this. Mitigations in the product: the caller's side shows who
  is requesting verification when the challenge arrives inside a seal from a
  pinned contact, and the README tells users that green covers the picture
  only.
* **Social engineering of the challenge.** If the genuine person is tricked
  into typing the victim's challenge words, the session check passes. The
  content check still fails for any modified video, so the outcome stays red.
* **Edits below the digest's resolution.** The digest tolerates what a codec
  does to a picture, so an edit that is no bigger than codec damage can pass.
  This was measured, and the result is not comfortable: replacing only the
  mouth region of a genuine sealed stream stayed green in most periods, and
  so did bending the face by 3% of its size. A 6% bend was mostly caught and
  a 12% bend always (EVALUATION.md, sections 3.4 and 6.2). An attacker who
  relays a genuine live stream and re-animates only the lips is therefore
  **not** stopped by this version. Binding the mouth more tightly (landmark
  motion, or a finer hash of that region) and binding the audio are the
  two changes that would close this.
* **A real face-swap model was not tested.** The "replaced face" attacks are
  made by pasting and blending, not by a neural network. A good face swap
  keeps pose, lighting and expression, and may land closer to the genuine
  picture than a pasted face does.

### T4. Re-encoding, cropping, scaling, re-filming

*Outcome: still verifies, or degrades to amber. Never a forged green.*

Processing can only destroy information. If the statement can no longer be
decoded, the period is "seal unreadable" (amber). If it decodes, it is the
genuine statement and it is compared against the processed pictures: a match
is a true green, a marginal comparison is amber. Processing cannot create a
signature, so it cannot create a green for content the key holder did not
send. A decode error cannot produce red either: the CRC rejects it first.

Processing that moves the picture (a crop, for instance) changes what is
inside the signed face box. If the seal still decodes, the comparison can
then fail and the badge can turn red although nobody attacked the call.
That is a false alarm, not a false green; EVALUATION.md, section 6.3, shows
how often each kind of processing ends in each colour.

### T5. Attacker seals with their own key and claims to be someone else

*Outcome: the badge names the key's owner, not the claimed person.*

The verifier ignores display names. It looks up the key id among pinned
contacts and organisation keys. An attacker's key is either unknown ("sealed
by a key you have not verified", amber) or pinned under the attacker's own
name, in which case the green badge shows that name. Key ids are short (32
bits), so an attacker can grind out a key whose id collides with a contact's.
The signature then fails under the pinned key and the verifier shows red: "this
seal claims to come from Mum but its signature is wrong".

### T6. Lost device or stolen key

*Outcome: revocation and rotation.*

Recovery flow:

1. On any remaining device, or from the paper recovery sheet printed at setup,
   the user issues a revocation statement for the lost key. The recovery sheet
   holds a pre-signed revocation as a QR code, so revoking does not need the
   lost device.
2. The user creates a new key and re-pairs with contacts in person or by
   safety number. Contacts who import the revocation see the old key marked
   revoked and any seal from it as red.
3. Organisations add the key to the `revoked` list in their JSON file and
   publish a new key. Verifiers refresh the file at least daily and before
   showing green for an organisation whose cached copy is older than a day.

Between the theft and the moment a contact learns of the revocation, the thief
can produce valid seals. This window is real and is stated in the README.
Devices should be locked; LiveSeal keys are only as safe as the browser
profile that holds them.

### T7. Downgrade: hoping the user ignores amber

*Outcome: a warning that is hard to miss.*

The verifier remembers, per contact, how often their recent calls were sealed.
When a tile's display name matches a contact who usually seals and the call is
not sealed, the badge is replaced by a full-width warning: "Mum usually
verifies. This call does not." The warning is announced to screen readers and
does not disappear until dismissed. For organisations the same rule applies
from the first call, because an organisation that publishes keys is expected
to seal every call.

## Out of scope

* **A fully compromised caller device.** Malware on the caller's device can
  feed any video to the sealing step. The seal proves the device and key, not
  the camera.
* **A genuine person who lies.** LiveSeal authenticates the sender, not their
  intentions.
* **Voice-only calls.** There is no picture to carry a seal. Listed as future
  work together with audio binding for video calls.
* **A compromised receiver device.** Malware on the receiving side can draw
  any badge it likes.
* **Denial of service.** Anyone on the path can destroy the seal and force
  amber. They cannot force green.

## What an observer learns from a seal

Anyone who can see the video can extract the statement. It contains: a key id
(the same value in every call made with that key, so calls can be linked to
one sender), a timestamp, a counter, the three-byte session value, the face
box and the digest. The digest and face box describe the pictures the observer
is already looking at. The statement contains no name, account, location or
contact list. A sender who does not want calls to be linkable should not seal
calls to people they do not want to be recognised by.
