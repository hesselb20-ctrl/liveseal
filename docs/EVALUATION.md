# LiveSeal evaluation

Every table in this file is generated from result files by
`codec-sim/make-tables.ts`. Nothing here is typed in by hand except the
explanations and the browser loop-back results, which are copied from the lab
page into `docs/browser-loopback.json`.

## 0. What kind of evidence this is

Read this first. Each result below belongs to one of four levels, and they
are not interchangeable.

| Level | What it means | Where |
|---|---|---|
| **Unit-tested** | Logic checked on synthetic input, no codec. | `core/test/`, 49 tests |
| **Simulator** | Real video clips, real encoders and decoders (ffmpeg: libvpx, libx264, libaom) with real-time settings, the real receiver code. No network, no browser. | sections 2, 3, 4, 6 |
| **Browser loop-back** | A real WebRTC call inside one browser page: the browser's own encoder, packetiser, jitter buffer and decoder at a chosen codec and bitrate. No network between two machines, no camera (a video file stands in for it). | section 7 |
| **Real call** | Two devices, a real network, a real camera, a real call service. | **Not done.** See section 8. |

Nothing in this document was measured on a real call between two machines.
The targets in the project brief that require one (Jitsi, Meet, Teams, Zoom,
two laptops, phone pointed at a screen, human viewers) are listed as open in
section 8 and are not claimed anywhere.

### Test material

* 13 public test clips from the Xiph.org collection: four 720p video-conference
  clips (Johnny, KristenAndSara, vidyo1, vidyo4) and nine CIF clips of people
  talking or signing (akiyo, news, silent, mother_daughter, paris, deadline,
  sign_irene, students, foreman). The clips are 10 seconds long; longer runs
  play them forwards and backwards so there is never a cut. `foreman` is filmed
  with a hand-held camera and is reported separately.
* Encoder settings mirror what real-time call stacks use: no look-ahead,
  constant bitrate, one keyframe at the start, error resilience on, and the
  encoder's temporal denoiser switched on for VP8 and VP9.
* The "attack" pictures are made with plain image operations (see section 3).
  No neural face-swap model was used: the test clips show other people, and
  the project rules allow such models only on footage we own. This is a real
  limit of the evidence and is repeated where it matters.

## 1. Results against the targets

<!-- table:targets -->
| Metric | Target | Result | Met? | Level |
|---|---|---|---|---|
| False green across the attack suite | 0 in at least 10,000 attack periods | 0 green in 10608 attack periods for attacks that replace the person, the scene, the key or the time. Separately, edits below the digest's resolution (mouth only, small warps, short delays) were green in 360 of 1190 periods (section 6.2). | Yes for the first group. **No** for sub-resolution edits. | Simulator |
| Statement recovery, VP8 at 600 kbps | at least 99% per period | 347 of 348 (99.7%) at 640x360 with the encoder denoiser on (section 2.1) | Yes, in the simulator. Not at an amplitude viewers cannot see (section 5). | Simulator |
| Time to green on a real call | at most 5 s | No real call. Browser loop-back, VP8 600 kbps: 8 runs: 5.7 to 7.4 s, median 6.5 s when both ends start together; 12 of 12 joins reached green: 4.1 to 5.9 s, median 5.1 s when the call is already sealed. | **No.** Two statements are needed, which takes 4 to 6 s by design. | Browser loop-back |
| Green stays up during a normal call | at least 95% of periods | Simulator: 98.8% of periods after the first green, over 48 genuine runs (section 6.3). Browser loop-back: 100% in 11 of 11 runs (section 7.1). | Yes, on static-camera test clips | Simulator, browser loop-back |
| Relay attack detected | 100% amber or red, at least 90% red | 384 of 384 (100.0%) of relay runs had no green period; 384 of 384 (100.0%) reached red (section 6.1). The sub-resolution relay edits of section 6.2 are not counted here. | Yes, for a replaced face or person | Simulator |
| Blind A/B invisibility | at most 60% correct | No viewers took part. On a flat, clean background the default seal can be seen with the naked eye (section 5). | **No** | Observation |
| Sender overhead | under 15% of one core at 720p30 | 5.91 ms (17.7% of one core at 30 fps) at 720p; 2.55 ms (7.6% of one core at 30 fps) at 360p. Page work only, one machine. | **No** at 720p | Browser loop-back |
| Platforms verified end to end | Jitsi, Meet, Teams web, Zoom | None. No call between two machines was made (section 8). | **No** | none |
<!-- /table -->

"Met?" is judged at the level of evidence shown in the last column. No target
is met on a real call, because no real call was made.

## 2. The hidden channel through real codecs

One run seals a clip, encodes it, decodes it and feeds the frames to the
receiver. A period counts as recovered only if the statement bytes come back
bit-exact. Seal amplitude is given per plane (Y / Cb / Cr) in 8-bit levels.

### 2.1 Headline condition: VP8, 600 kbps, 640x360, encoder denoiser on

Four conference clips, three different payloads and timings each, 60 seconds
per run.

<!-- table:headline -->
| Seal amplitude (Y / Cb / Cr) | Runs | Periods | Statements recovered | Wrong decodes | First statement after stream start | Luma PSNR of the seal |
|---|---|---|---|---|---|---|
| default (2 / 3 / 3) | 12 | 348 | 347 of 348 (99.7%) | 0 | 2.9 to 3.8 s | 42.5 dB |
| light (1.5 / 2 / 2) | 12 | 348 | 282 of 348 (81.0%) | 0 | 2.9 to 7.3 s | 44.5 dB |
<!-- /table -->

Per clip:

<!-- table:headline-clips -->
| Clip | Seal | Statements recovered |
|---|---|---|
| johnny | default (2 / 3 / 3) | 87 of 87 (100.0%) |
| johnny | light (1.5 / 2 / 2) | 86 of 87 (98.9%) |
| kristen_sara | default (2 / 3 / 3) | 86 of 87 (98.9%) |
| kristen_sara | light (1.5 / 2 / 2) | 69 of 87 (79.3%) |
| vidyo1 | default (2 / 3 / 3) | 87 of 87 (100.0%) |
| vidyo1 | light (1.5 / 2 / 2) | 60 of 87 (69.0%) |
| vidyo4 | default (2 / 3 / 3) | 87 of 87 (100.0%) |
| vidyo4 | light (1.5 / 2 / 2) | 67 of 87 (77.0%) |
<!-- /table -->

The default seal meets the 99% target here; the light seal does not. The
difference is the encoder's denoiser, which treats small luma steps as noise
and removes them. With the denoiser on, the colour-difference planes carry
almost the whole statement.

### 2.2 Every codec and bitrate, 640x360 (four conference clips, 20 s each)

Default seal:

<!-- table:matrix-360-default -->
| Codec | 300 kbps | 600 kbps | 1 Mbps | 2 Mbps |
|---|---|---|---|---|
| VP8, denoiser on | 6/36 (16.7%) | 36/36 (100.0%) | 36/36 (100.0%) | 36/36 (100.0%) |
| VP8, denoiser off | 25/36 (69.4%) | 36/36 (100.0%) | 36/36 (100.0%) | 36/36 (100.0%) |
| VP9, denoiser on | 36/36 (100.0%) | 36/36 (100.0%) | 36/36 (100.0%) | 36/36 (100.0%) |
| H.264 baseline | 36/36 (100.0%) | 36/36 (100.0%) | 36/36 (100.0%) | 36/36 (100.0%) |
| AV1 | 36/36 (100.0%) | 36/36 (100.0%) | 36/36 (100.0%) | 36/36 (100.0%) |
<!-- /table -->

Light seal:

<!-- table:matrix-360-light -->
| Codec | 300 kbps | 600 kbps | 1 Mbps | 2 Mbps |
|---|---|---|---|---|
| VP8, denoiser on | 0/36 (0.0%) | 32/36 (88.9%) | 36/36 (100.0%) | 36/36 (100.0%) |
| VP8, denoiser off | 5/36 (13.9%) | 32/36 (88.9%) | 36/36 (100.0%) | 36/36 (100.0%) |
| VP9, denoiser on | 35/36 (97.2%) | 36/36 (100.0%) | 36/36 (100.0%) | 36/36 (100.0%) |
| H.264 baseline | 36/36 (100.0%) | 36/36 (100.0%) | 36/36 (100.0%) | 36/36 (100.0%) |
| AV1 | 36/36 (100.0%) | 36/36 (100.0%) | 36/36 (100.0%) | 36/36 (100.0%) |
<!-- /table -->

Each cell counts all periods of the run, including the first two after the
encoder starts.

The failure in this table is VP8 at 300 kbps: with the encoder denoiser on,
6 of 36 statements arrive with the default seal and none with the light one.
At that bitrate the encoder quantises so coarsely that the seal's steps are
dropped along with the noise. Every other codec carries the default seal at
300 kbps.

### 2.3 CIF clips, 352x288 (eight clips, static camera)

Default seal:

<!-- table:matrix-cif-default -->
| Codec | 300 kbps | 600 kbps |
|---|---|---|
| VP8, denoiser on | 41/72 (56.9%) | 71/72 (98.6%) |
| VP8, denoiser off | 62/72 (86.1%) | 72/72 (100.0%) |
| VP9, denoiser on | 71/72 (98.6%) | 72/72 (100.0%) |
| H.264 baseline | 72/72 (100.0%) | 72/72 (100.0%) |
| AV1 | 71/72 (98.6%) | 72/72 (100.0%) |
<!-- /table -->

Light seal:

<!-- table:matrix-cif-light -->
| Codec | 300 kbps | 600 kbps |
|---|---|---|
| VP8, denoiser on | 20/72 (27.8%) | 58/72 (80.6%) |
| VP8, denoiser off | 34/72 (47.2%) | 69/72 (95.8%) |
| VP9, denoiser on | 65/72 (90.3%) | 72/72 (100.0%) |
| H.264 baseline | 66/72 (91.7%) | 71/72 (98.6%) |
| AV1 | 65/72 (90.3%) | 72/72 (100.0%) |
<!-- /table -->

### 2.4 Hand-held camera (the `foreman` clip)

<!-- table:matrix-handheld-default -->
| Codec | 300 kbps | 600 kbps |
|---|---|---|
| VP8, denoiser off | 0/9 (0.0%) | 6/9 (66.7%) |
| H.264 baseline | 6/9 (66.7%) | 6/9 (66.7%) |
| VP9, denoiser on | 2/9 (22.2%) | 6/9 (66.7%) |
| VP8, denoiser on | 0/9 (0.0%) | 5/9 (55.6%) |
| AV1 | 6/9 (66.7%) | 6/9 (66.7%) |
<!-- /table -->

This is a failure, stated plainly: between none and two thirds of the
statements arrive, which is not enough to hold a green badge. The receiver
subtracts consecutive time slots to cancel the picture, which only works
where the picture holds still. A camera that moves the whole frame leaves
nothing to subtract. A caller holding a phone in their hand will mostly show
"not verified". Motion compensation in the receiver is the fix and is not
built.

### 2.5 720p and 1080p

720p, four conference clips, default seal:

<!-- table:matrix-720-default -->
| Codec | 600 kbps | 1 Mbps | 2 Mbps |
|---|---|---|---|
| VP8, denoiser on | 4/36 (11.1%) | 35/36 (97.2%) | 36/36 (100.0%) |
| VP8, denoiser off | 9/36 (25.0%) | 36/36 (100.0%) | 36/36 (100.0%) |
| VP9, denoiser on | 36/36 (100.0%) | 36/36 (100.0%) | 36/36 (100.0%) |
| H.264 baseline | 36/36 (100.0%) | 36/36 (100.0%) | 36/36 (100.0%) |
| AV1 | 36/36 (100.0%) | 36/36 (100.0%) | 36/36 (100.0%) |
<!-- /table -->

720p, light seal:

<!-- table:matrix-720-light -->
| Codec | 600 kbps | 1 Mbps | 2 Mbps |
|---|---|---|---|
| VP8, denoiser on | 0/36 (0.0%) | 8/36 (22.2%) | 36/36 (100.0%) |
| VP8, denoiser off | 6/36 (16.7%) | 19/36 (52.8%) | 36/36 (100.0%) |
| VP9, denoiser on | 35/36 (97.2%) | 36/36 (100.0%) | 36/36 (100.0%) |
| H.264 baseline | 36/36 (100.0%) | 36/36 (100.0%) | 36/36 (100.0%) |
| AV1 | 36/36 (100.0%) | 36/36 (100.0%) | 36/36 (100.0%) |
<!-- /table -->

1080p (one clip, upscaled from 720p because the test set has no native 1080p
conference footage), default seal:

<!-- table:matrix-1080-default -->
| Codec | 2 Mbps |
|---|---|
| VP9, denoiser on | 5/5 (100.0%) |
| VP8, denoiser off | 5/5 (100.0%) |
| VP8, denoiser on | 5/5 (100.0%) |
| AV1 | 5/5 (100.0%) |
| H.264 baseline | 5/5 (100.0%) |
<!-- /table -->

Bits per pixel decide the outcome. 600 kbps is too little for 720p with VP8 or
H.264, and the seal goes with it. A real call stack would lower the resolution
at that bitrate instead.

### 2.6 Unsealed video is never reported as sealed

<!-- table:null -->
| Unsealed runs | Seconds of video | Periods reported as sealed | Highest pilot score seen | Detection threshold |
|---|---|---|---|---|
| 130 | 3900 | 0 | 0.18 | 0.30 |
<!-- /table -->

### 2.7 A decode is either right or absent

Across every sealed run in this section and in sections 2.8 and 4:

<!-- table:wrong-total -->
| Sealed runs | Periods sent | Periods recovered | Periods decoded to something else |
|---|---|---|---|
| 782 | 7478 | 6158 | 0 |
<!-- /table -->

### 2.8 What the call path may do to the picture (T4)

VP8, 600 kbps, 640x360, denoiser on, four conference clips. Default seal:

<!-- table:impair-default -->
| Condition (VP8, 600 kbps, 640x360, denoiser on) | Statements recovered | Wrong decodes |
|---|---|---|
| 15 fps | 36 of 36 (100.0%) | 0 |
| 30% frames lost | 35 of 36 (97.2%) | 0 |
| 10% frames lost | 36 of 36 (100.0%) | 0 |
| baseline | 36 of 36 (100.0%) | 0 |
| sent at 320x180, 300 kbps | 35 of 36 (97.2%) | 0 |
| crop 1% | 36 of 36 (100.0%) | 0 |
| sent at 480x270 | 36 of 36 (100.0%) | 0 |
| crop 2% | 36 of 36 (100.0%) | 0 |
| brighter, more contrast | 36 of 36 (100.0%) | 0 |
| upscaled by the receiver | 36 of 36 (100.0%) | 0 |
| crop 4% | 21 of 36 (58.3%) | 0 |
| darker | 36 of 36 (100.0%) | 0 |
| re-filmed model, 0px registration error | 36 of 36 (100.0%) | 0 |
| crop 8% | 0 of 36 (0.0%) | 0 |
| re-encoded: VP8 then H.264 600 kbps | 36 of 36 (100.0%) | 0 |
| re-filmed model, 2px registration error | 36 of 36 (100.0%) | 0 |
| re-encoded: VP8 then VP9 300 kbps | 9 of 36 (25.0%) | 0 |
| re-filmed model, 5px registration error | 15 of 36 (41.7%) | 0 |
<!-- /table -->

Light seal:

<!-- table:impair-light -->
| Condition (VP8, 600 kbps, 640x360, denoiser on) | Statements recovered | Wrong decodes |
|---|---|---|
| 15 fps | 35 of 36 (97.2%) | 0 |
| 30% frames lost | 29 of 36 (80.6%) | 0 |
| 10% frames lost | 33 of 36 (91.7%) | 0 |
| baseline | 29 of 36 (80.6%) | 0 |
| sent at 480x270 | 36 of 36 (100.0%) | 0 |
| sent at 320x180, 300 kbps | 24 of 36 (66.7%) | 0 |
| upscaled by the receiver | 25 of 36 (69.4%) | 0 |
| crop 1% | 32 of 36 (88.9%) | 0 |
| crop 4% | 0 of 36 (0.0%) | 0 |
| crop 2% | 24 of 36 (66.7%) | 0 |
| crop 8% | 0 of 36 (0.0%) | 0 |
| brighter, more contrast | 28 of 36 (77.8%) | 0 |
| darker | 32 of 36 (88.9%) | 0 |
| re-encoded: VP8 then H.264 600 kbps | 14 of 36 (38.9%) | 0 |
| re-encoded: VP8 then VP9 300 kbps | 0 of 36 (0.0%) | 0 |
| re-filmed model, 0px registration error | 13 of 36 (36.1%) | 0 |
| re-filmed model, 2px registration error | 17 of 36 (47.2%) | 0 |
| re-filmed model, 5px registration error | 0 of 36 (0.0%) | 0 |
<!-- /table -->

The "re-filmed" rows are a model, not a phone: the picture is given a mild
keystone, blurred, gamma-shifted, given sensor noise, encoded again and then
straightened with a registration error of a few pixels. Screen refresh,
moire, focus and exposure hunting are not modelled.

## 3. The content digest

### 3.1 Method

For each of the 12 clips with a clearly visible face, the genuine video was
sealed and sent through 12 codec conditions. Then 13 attack videos were made
from it and sent through 4 conditions each. Every run is 30 seconds; the first
period is left out because the encoder is still warming up (section 3.5).

<!-- table:digest-summary -->
| Runs | Genuine periods | Attack periods | Candidates compared |
|---|---|---|---|
| 768 | 2016 | 8736 | 72 |
<!-- /table -->

The attacks:

* **another person**: a completely different clip;
* **face replaced**: the face region of another clip pasted over the face,
  matched in brightness and contrast, with a feathered edge;
* **face bent**: the genuine face with its geometry warped by 3%, 6% or 12%
  of the face size;
* **mouth replaced**: only the mouth region, taken from the same person a
  moment later (a stand-in for lip-sync editing);
* **delayed** and **frozen**: the genuine video, late or stuck.

These are proxies. A good neural face swap keeps pose, lighting and
expression and changes only identity, so it is likely to land closer to the
genuine picture than a pasted face does. The "face bent" rows are the nearest
thing in this test to that, and they show where the digest stops working.

### 3.2 Candidates

Four hash families, each with 32, 48 or 64 bits per snapshot, 2, 4 or 8
snapshots per period, with and without confidence weighting. "Separation" is
the smallest distance of a replaced face divided by the largest genuine
distance. The hard requirement is that no replaced face or other person may
ever fall under the match threshold, with thresholds set at 1.25 and 1.75
times the largest genuine distance. "Subtle edits that still match" is the
average, over the 3% and 6% warps, both mouth edits, the frozen and the
0.5 s-late video, of the share of periods that would be accepted.

<!-- table:digest-candidates -->
| Candidate | Bytes | Genuine distance (median / 99th / max) | Replaced face: smallest distance | Separation | Meets the hard requirement | Subtle edits that still match |
|---|---|---|---|---|---|---|
| gradient, 64 bits x 8 snapshots, weighted | 64 | 0.004 / 0.035 / 0.040 | 0.159 | 3.94x | yes | 43.6% |
| gradient, 48 bits x 4 snapshots, weighted **(chosen)** | 24 | 0.003 / 0.034 / 0.044 | 0.106 | 2.43x | yes | 46.9% |
| dct, 48 bits x 4 snapshots, weighted | 24 | 0.002 / 0.027 / 0.032 | 0.083 | 2.56x | yes | 48.0% |
| block, 64 bits x 8 snapshots, weighted | 64 | 0.002 / 0.017 / 0.022 | 0.040 | 1.87x | yes | 48.2% |
| dct, 64 bits x 8 snapshots, weighted | 64 | 0.003 / 0.032 / 0.042 | 0.104 | 2.47x | yes | 49.4% |
| projection, 64 bits x 4 snapshots, weighted | 32 | 0.001 / 0.015 / 0.025 | 0.047 | 1.89x | yes | 64.0% |
| projection, 48 bits x 8 snapshots, weighted | 48 | 0.001 / 0.014 / 0.027 | 0.051 | 1.86x | yes | 64.8% |
| block, 48 bits x 8 snapshots, weighted | 48 | 0.002 / 0.016 / 0.022 | 0.037 | 1.71x | no | 47.1% |
| dct, 48 bits x 4 snapshots | 24 | 0.026 / 0.094 / 0.120 | 0.130 | 1.09x | no | 68.3% |
| gradient, 48 bits x 4 snapshots | 24 | 0.031 / 0.083 / 0.130 | 0.161 | 1.24x | no | 72.9% |
<!-- /table -->

The gradient hash with weighting wins at every size. 48 bits by 4 snapshots
(24 bytes) was chosen: it separates almost as well as the 64-byte version and
leaves room in the statement.

### 3.3 The chosen digest: genuine video

Distance between what the sender signed and what the receiver computed from
the decoded frames, by codec condition:

<!-- table:digest-conditions -->
| Codec condition | Genuine distance, 95th percentile | Largest |
|---|---|---|
| vp8dn-1000 | 0.019 | 0.044 |
| vp9dn-600 | 0.020 | 0.039 |
| vp8dn-600 | 0.019 | 0.041 |
| vp9dn-300 | 0.018 | 0.034 |
| av1-300 | 0.024 | 0.038 |
| vp8dn-300 | 0.017 | 0.034 |
| h264-600 | 0.020 | 0.037 |
| vp8dn-300-half | 0.022 | 0.037 |
| vp8dn-600-15fps | 0.024 | 0.043 |
| vp8-600 | 0.024 | 0.038 |
| h264-300 | 0.023 | 0.039 |
| av1-600 | 0.024 | 0.034 |
<!-- /table -->

### 3.4 The chosen digest: attacks

<!-- table:digest-attacks -->
| Attack on the picture | Periods | Distance (smallest / 5th percentile / median) | AUC against genuine |
|---|---|---|---|
| A different person and scene | 1344 | 0.288 / 0.371 / 0.479 | 1.0000 |
| Another face pasted in, colour-matched | 2016 | 0.106 / 0.218 / 0.327 | 1.0000 |
| Same face, geometry bent by 12% | 672 | 0.135 / 0.156 / 0.227 | 1.0000 |
| Same face, geometry bent by 6% | 672 | 0.026 / 0.052 / 0.105 | 0.9997 |
| Same face, geometry bent by 3% | 672 | 0.007 / 0.013 / 0.036 | 0.9724 |
| Same video, 2 s late | 672 | 0.037 / 0.059 / 0.261 | 1.0000 |
| Same video, 0.5 s late | 672 | 0.013 / 0.033 / 0.134 | 0.9975 |
| Same video, frozen each period | 672 | 0.019 / 0.047 / 0.157 | 0.9984 |
| Mouth region from 0.7 s later | 672 | 0.000 / 0.005 / 0.027 | 0.9216 |
| Mouth region from 0.3 s later | 672 | 0.000 / 0.001 / 0.014 | 0.7913 |
<!-- /table -->

<!-- table:digest-frame -->
| Whole-frame hash (32 bits x 2 snapshots) | Value |
|---|---|
| Largest genuine distance | 0.006 |
| Smallest distance for a different scene | 0.232 |
<!-- /table -->

Thresholds in `core/src/digest.ts`: a face distance up to 0.055 is a match,
0.085 or more is a mismatch, anything between is uncertain (amber). The
largest genuine distance measured was 0.044 and the smallest replaced-face
distance 0.106. For the whole-frame hash the thresholds are 0.05 and 0.12.

**What this means in plain words.** Replacing the person, or pasting another
face in, is far outside what genuine video ever does. Bending the same face by
12% is caught every time and by 6% most of the time. Bending it by 3%, or
changing only the mouth, is mostly inside the tolerance the codec forces us to
allow, and is **not detected**. LiveSeal does not protect against lip-sync
edits of a genuine sealed stream.

### 3.5 The first second of a stream

While the encoder is warming up the picture is blurred enough that a genuine
stream can exceed the mismatch threshold in its first period. Two rules
handle this without weakening anything: a single content mismatch is reported
as uncertain (amber), and red needs two in a row. An attacker gains nothing,
because neither state is green.

## 4. Design choices that were measured, not guessed

All variants on the same three conditions, four conference clips, 20 s each,
light seal unless stated.

<!-- table:design -->
| Variant | VP8 600 kbps, denoiser on | H.264 600 kbps | VP9 300 kbps |
|---|---|---|---|
| luma only, Reed-Solomon | 1 of 36 (2.8%) | 4 of 36 (11.1%) | 11 of 36 (30.6%) |
| luma only, LDPC | 8 of 36 (22.2%) | 13 of 36 (36.1%) | 17 of 36 (47.2%) |
| luma only, LDPC, strong | 26 of 36 (72.2%) | 32 of 36 (88.9%) | 34 of 36 (94.4%) |
| three planes, LDPC (chosen) | 29 of 36 (80.6%) | 36 of 36 (100.0%) | 35 of 36 (97.2%) |
| three planes, soft edges 0.6 | 21 of 36 (58.3%) | 36 of 36 (100.0%) | 35 of 36 (97.2%) |
| three planes, hard edges | 26 of 36 (72.2%) | 36 of 36 (100.0%) | 35 of 36 (97.2%) |
| three planes, 100 ms cross-fade | 29 of 36 (80.6%) | 36 of 36 (100.0%) | 35 of 36 (97.2%) |
| three planes, no cross-fade | 30 of 36 (83.3%) | 36 of 36 (100.0%) | 36 of 36 (100.0%) |
| three planes, 48x27 grid | 21 of 36 (58.3%) | 36 of 36 (100.0%) | 13 of 36 (36.1%) |
| three planes, 24x14 grid | 33 of 36 (91.7%) | 36 of 36 (100.0%) | 36 of 36 (100.0%) |
| three planes, 16 slots | 29 of 36 (80.6%) | 36 of 36 (100.0%) | 28 of 36 (77.8%) |
| three planes, 4 slots | 27 of 36 (75.0%) | 36 of 36 (100.0%) | 35 of 36 (97.2%) |
<!-- /table -->

What the table shows:

* **Luma alone is not enough.** With the VP8 denoiser on, a luma-only seal at
  the same amplitude loses most statements, whichever error-correcting code is
  used.
* **Three planes** bring the statement through because the denoiser is much
  gentler on colour.
* **Reed-Solomon against LDPC.** Reed-Solomon works on bytes and needs hard
  decisions; picture motion damages a few bits in many bytes. The soft-decision
  LDPC code uses every bit with its own confidence.
* Cell size, edge softness, slot count and cross-fade length each have a row;
  the chosen values are the ones in `core/src/modem.ts`.
* **One row beats the chosen design.** A coarser 24 x 14 grid recovered more
  statements than the chosen 32 x 18 grid on the VP8 condition with the light
  seal. It was measured after the main sweeps had been run with 32 x 18 and
  was not adopted in this version; with the default seal the chosen grid is
  already at 99.7% on that condition. Re-running everything with the coarser
  grid is an obvious next experiment.

## 5. Visibility

**The default seal is not invisible.** No test with people was run, but one
is hardly needed for the worst case: in the lab page with the drawn stand-in,
whose wall is a flat, noise-free gradient, the seal shows as a faint mosaic of
coloured blocks, before and after the call encoder. The two screenshots on
the landing page (`docs/media/`) were taken that way and show it.

What is known:

* The seal changes luma by at most 2 levels and each colour-difference plane
  by at most 3 levels out of 255, in cells of one eighteenth of the picture
  height, changing four times a second with a 34 ms cross-fade.
* Luma PSNR of the seal alone is in the table of section 2.1. The colour
  offsets do not show in that figure and are the part that is seen.
* A real camera picture has sensor noise and texture that hide some of this.
  How much is not measured.
* The light seal (1.5 / 2 / 2) is harder to see and loses a fifth of its
  statements through VP8 with the denoiser on (section 2.1). The amplitude
  that survives that denoiser and the amplitude a viewer cannot see do not
  currently overlap on flat backgrounds. That is an open problem.

`abtest/` is a blind test page: two copies of the picture, one sealed, in
random order, 20 rounds, with the chance level and a downloadable result
file. "Invisible" is not a claim this project makes.

## 6. Attack suite (simulator, real codecs)

`codec-sim/run-attacks.ts`. For every clip a genuine sender with a real key
seals its own camera picture: real statements, real signatures, the real
digest. The attacker's picture, with or without the seal lifted onto it, goes
through a real codec, and the real receiver session produces a badge for
every period. Twelve victim clips, four codec conditions (VP8 600 kbps with
denoiser, H.264 600 kbps, VP9 300 kbps with denoiser, AV1 600 kbps), 30
seconds per run. The seal is copied perfectly in every relay case, which is
the best an attacker can do.

### 6.1 Attacks that must never be green

<!-- table:attacks-must -->
| Threat | What the attacker does | Runs | Periods | Green periods | Amber | Red | Runs with red / with green |
|---|---|---|---|---|---|---|---|
| T1 | another person, no seal | 48 | 624 | 0 | 624 | 0 | 0 / 0 |
| T1 | swapped face, no seal | 48 | 624 | 0 | 624 | 0 | 0 / 0 |
| T2 | recording played one hour later | 48 | 672 | 0 | 1 | 671 | 48 / 0 |
| T2 | recording from a call with another challenge | 48 | 672 | 0 | 0 | 672 | 48 / 0 |
| T2 | unchallenged recording against a fresh challenge | 48 | 672 | 0 | 672 | 0 | 0 / 0 |
| T3 | seal lifted onto a swapped face (a) | 48 | 672 | 0 | 48 | 624 | 48 / 0 |
| T3 | seal lifted onto a swapped face (b) | 48 | 672 | 0 | 48 | 624 | 48 / 0 |
| T3 | seal lifted onto a swapped face (c) | 48 | 672 | 0 | 49 | 623 | 48 / 0 |
| T3 | seal lifted onto another person (a) | 48 | 672 | 0 | 49 | 623 | 48 / 0 |
| T3 | seal lifted onto another person (b) | 48 | 672 | 0 | 49 | 623 | 48 / 0 |
| T3 | seal lifted, challenge relayed, swapped face | 48 | 672 | 0 | 48 | 624 | 48 / 0 |
| T3 | seal lifted onto a face bent by 12% | 48 | 672 | 0 | 49 | 623 | 48 / 0 |
| T5 | sealed with an unverified key | 48 | 672 | 0 | 672 | 0 | 0 / 0 |
| T6 | sealed with a revoked key | 48 | 672 | 0 | 1 | 671 | 48 / 0 |
| T7 | no seal, claims to be a contact who seals | 48 | 624 | 0 | 624 | 0 | 0 / 0 |
| T3 | seal lifted onto a swapped face (d) | 48 | 672 | 0 | 50 | 622 | 48 / 0 |
<!-- /table -->

<!-- table:attacks-total -->
| Measure | Result |
|---|---|
| Attack periods in the "must never be green" group | 10608 |
| Green periods among them | 0 |
| Relay (T3) runs | 384 |
| Relay runs that ended amber or red (no green at any point) | 384 of 384 (100.0%) |
| Relay runs that reached red | 384 of 384 (100.0%) |
| T7 periods shown as a strong warning | 624 of 624 (100.0%) |
<!-- /table -->

### 6.2 Edits below the digest's resolution (known limit)

These are relay attacks too: a genuine live seal on a picture that differs
only slightly from the genuine one. They are listed apart because the digest
was measured not to catch them reliably (section 3.4), and it would be
dishonest to leave them out of the suite.

<!-- table:attacks-limit -->
| Threat | What the attacker does | Runs | Periods | Green periods | Amber | Red | Runs with red / with green |
|---|---|---|---|---|---|---|---|
| T3-limit | face bent by 6% | 12 | 168 | 0 | 16 | 152 | 12 / 0 |
| T3-limit | face bent by 3% | 12 | 168 | 80 | 88 | 0 | 0 / 12 |
| T3-limit | mouth replaced (0.7 s offset) | 13 | 182 | 130 | 52 | 0 | 0 / 13 |
| T3-limit | mouth replaced (0.3 s offset) | 12 | 168 | 136 | 32 | 0 | 0 / 12 |
| T3-limit | picture frozen every period | 12 | 168 | 4 | 51 | 113 | 12 / 4 |
| T3-limit | picture delayed by 0.5 s | 12 | 168 | 4 | 34 | 130 | 11 / 2 |
| T3-limit | picture delayed by 2 s | 12 | 168 | 6 | 18 | 144 | 12 / 5 |
<!-- /table -->

Green periods in this table are false greens. They are the price of a digest
that tolerates a call codec.

### 6.3 Genuine calls and harmless processing (T4)

<!-- table:attacks-genuine -->
| Codec | Runs | Periods | Green | Amber | Red | Green share after the first green |
|---|---|---|---|---|---|---|
| h264-600 | 12 | 168 | 144 | 24 | 0 | 100.0% |
| vp9dn-300 | 12 | 168 | 141 | 27 | 0 | 97.9% |
| av1-600 | 12 | 168 | 144 | 24 | 0 | 100.0% |
| vp8dn-600 | 12 | 168 | 140 | 28 | 0 | 97.2% |
<!-- /table -->

<!-- table:attacks-process -->
| Threat | What the attacker does | Runs | Periods | Green periods | Amber | Red | Runs with red / with green |
|---|---|---|---|---|---|---|---|
| genuine | genuine call | 48 | 672 | 569 | 103 | 0 | 0 / 48 |
| T4 | re-encoded once more (H.264 600 kbps) | 12 | 168 | 140 | 28 | 0 | 0 / 12 |
| T4 | sent at half size | 12 | 168 | 144 | 24 | 0 | 0 / 12 |
| T4 | cropped by 4% | 12 | 168 | 19 | 100 | 49 | 5 / 3 |
| T4 | brightened | 12 | 168 | 144 | 24 | 0 | 0 / 12 |
<!-- /table -->

## 7. Browser loop-back

Measured with `scripts/browser-loopback.ts`, which drives an installed
Chromium-based browser (headless, fresh profile) through `lab/` on one
Windows laptop. The picture is a 640x360 conference clip played from a file
in place of a camera; it is sealed by the WebGL shader, sent through two
joined `RTCPeerConnection` objects with the codec and bitrate shown, and
verified from the receiving `<video>` element. There is no network between
two machines here, and one clip on one machine is a small sample. Each run
starts sender and receiver together from cold, so the first period carries no
statement yet and "time to green" includes that.

### 7.1 Genuine call

<!-- table:browser-genuine -->
| Codec | Target | Measured | Encoded size | Path | Periods | Time to green | Green after first green | Seal found (Y / Cb / Cr) |
|---|---|---|---|---|---|---|---|---|
| VP8 | 300 kbps | 299 kbps | 480x270 | canvas sealer + in-thread verifier | 29 | 7.0 s | 100% | 0.91 / 2.17 / 2.45 |
| VP8 | 600 kbps | 594 kbps | 640x360 | canvas sealer + in-thread verifier | 29 | 6.5 s | 100% | 1.02 / 2.44 / 2.65 |
| VP8 | 1000 kbps | 992 kbps | 640x360 | canvas sealer + in-thread verifier | 29 | 6.3 s | 100% | 1.35 / 2.76 / 2.94 |
| VP8 | 2000 kbps | 1956 kbps | 640x360 | canvas sealer + in-thread verifier | 19 | 6.0 s | 100% | 1.37 / 2.46 / 2.66 |
| VP9 | 300 kbps | 300 kbps | 640x360 | canvas sealer + in-thread verifier | 29 | 7.3 s | 100% | 1.83 / 2.57 / 2.67 |
| VP9 | 600 kbps | 597 kbps | 640x360 | canvas sealer + in-thread verifier | 29 | 6.9 s | 100% | 2.07 / 3.09 / 3.16 |
| H264 | 600 kbps | 603 kbps | 640x360 | canvas sealer + in-thread verifier | 29 | 6.4 s | 100% | 1.94 / 2.62 / 2.73 |
| H264 | 1000 kbps | 1004 kbps | 640x360 | canvas sealer + in-thread verifier | 19 | 5.7 s | 100% | 2.05 / 2.94 / 2.98 |
| AV1 | 600 kbps | 597 kbps | 640x360 | canvas sealer + in-thread verifier | 29 | 7.4 s | 100% | 2.22 / 2.99 / 3.03 |
| VP8 | 600 kbps | 603 kbps | 640x360 | insertable streams + worker verifier | 19 | 7.0 s | 100% | 0.95 / 2.41 / 2.51 |
| VP8 | 600 kbps | 588 kbps | 640x360 | canvas sealer + in-thread verifier | 19 | 6.7 s | 100% | 0.47 / 1.38 / 1.54 |
<!-- /table -->

### 7.2 Attacks

<!-- table:browser-attacks -->
| Attack in the lab | Badge per period before the attack | Badge per period after it began (a amber, g green, r red) | Green periods after it began |
|---|---|---|---|
| Fake picture, no seal (T1) | `aggggga` | `aaaaaaaaa` | 0 |
| Sealed recording played 5 minutes later (T2) | `agggggr` | `rrrrrrrrrr` | 0 |
| Another face pasted in under the copied seal (T3) | `aaggggg` | `arrrrrrrrr` | 0 |
| Another person under the copied seal (T3) | `aagggga` | `arrrrrrrrr` | 0 |
| Sealed with a key the receiver never verified (T5) | `aagggga` | `aaaaaaaaaa` | 0 |
| Sealed with a revoked key (T6) | `aaggggr` | `rrrrrrrrrr` | 0 |
<!-- /table -->

### 7.3 Cost and time to green

<!-- table:browser-cost -->
| Measure | Value |
|---|---|
| Browser | 157.0.8103.40 (headless) |
| Sealing, 640x360, per frame | 2.55 ms (7.6% of one core at 30 fps) |
| Verifying, per frame | 1.02 ms (3.1% of one core at 30 fps) |
| Sealing, 1280x720, per frame | 5.91 ms (17.7% of one core at 30 fps) |
| 1280x720 run | video/VP8 at 1970 kbps, encoded 1280x720, badge per period `aggggggggggggg` |
| Time to green from a cold start, VP8 600 kbps | 8 runs: 5.7 to 7.4 s, median 6.5 s |
| Time to green for a verifier joining a sealed call, VP8 600 kbps | 12 of 12 joins reached green: 4.1 to 5.9 s, median 5.1 s |
| Per-frame cost covers | the page's own work (reduction, digest, shader draw, sampling, decoding); the camera and the video encoder are extra |
<!-- /table -->

### 7.4 The organisation flow

`demo-bank/` fetches the bank's published key file as a verifier would, then
receives a sealed call from each kind of caller.

<!-- table:browser-bank -->
| Caller | Badge every 2 s | Final badge |
|---|---|---|
| Agent with a key signed by the bank | `aaagggggggg` | Verified: localhost:5173/demo-bank (Agent 042) : Sealed by a key published by localhost:5173/demo-bank. |
| Thief with the bank's revoked key | `aarrrrrrrrr` | Warning: revoked key : This seal was made with a key that localhost:5173/demo-bank has revoked. It may have been stolen. |
| Impostor with a key of their own | `aaaaaaaaaaa` | Not verified : localhost:5173/demo-bank usually verifies. This call does not. This video is sealed by a key you have not verified. Do not rely on the name on screen. |
| Caller with no seal | `aaaaaaaaaaa` | Not verified : localhost:5173/demo-bank usually verifies. This call does not. No seal was found in this video. |
<!-- /table -->

### 7.5 The recording checker

Two 24-second recordings were made by the simulator (a real sender session
with a real key, encoded as VP8 WebM at 1 Mbps) and checked by
`verifier/checker.html` in the browser, after pairing with the key through
the page's own pairing panel. Per period: v valid, u uncertain, M mismatch,
s seal starting.

<!-- table:browser-checker -->
| Recording | Report summary | Result per period |
|---|---|---|
| Sealed, untouched | 11 of 11 periods carry a valid seal from Recorded caller. | vvvvvvvvvvv |
| Sealed, second half shows another face under the seal | 5 of 11 periods carry a valid seal from Recorded caller. 3 periods failed a check (content-mismatch): the first at 19.1 s. 3 periods have no readable seal. | svvvvvuuMMM |
<!-- /table -->

## 8. Not done

These were asked for and are not delivered. None of them is claimed anywhere
in this repository.

1. **A real call between two machines.** No Jitsi, Meet, Teams, Zoom or
   WhatsApp call was made. Real networks add packet loss, bitrate swings,
   resolution changes and hardware encoders, none of which the simulator or
   the loop-back reproduce.
2. **The extension on real call sites.** It builds and its parts (the
   Insertable Streams sealer, the worker verifier, the tile badge) run in the
   lab page, but it was never loaded into Meet, Teams web, Zoom web or Jitsi.
   Sites that inspect or re-create camera tracks may need site-specific fixes.
3. **Phone mode on a real phone and screen.** Only the model in section 2.8.
4. **The virtual-camera bridge** through OBS into a desktop call app.
5. **Human A/B test.** Section 5.
6. **A neural face-swap attack.** Section 3.1.
7. **Real cameras.** All footage is clean test material. Webcam noise,
   auto-exposure and auto-focus will lower recovery and raise digest distance
   by an unknown amount.
8. **Hand-held senders.** Section 2.4: measured, and it does not work.
9. **Face tracking in the extension.** The camera page locates the face with
   an on-device detector. The extension does not load one yet and signs a
   fixed central region of the picture instead, which still binds the
   picture but less tightly when the face is off-centre.
10. **A recorded demo video.** The landing page shows two screenshots of the
    lab and links to the live lab; no video was recorded.
11. **WebGPU.** The sealing shader is WebGL2 only.
12. **Firefox and Safari.** The code avoids Chromium-only APIs where there
    is a fallback, but only a Chromium-based browser was used.
