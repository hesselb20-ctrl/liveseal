// Page-world shim. This is the only LiveSeal code that runs among the call
// site's own scripts, and it is deliberately dumb: it never sees a key, a
// statement or a camera frame. It asks the isolated content script for a
// sealed picture and hands the page a stream of it.
//
// A hostile page can tamper with this shim. The worst it can achieve is to
// send unsealed or altered video, which the other side then sees as "not
// verified" or as a picture that does not match.

import { EV_APPLY, EV_REQUEST, EV_RESPONSE, EV_STOP, type CameraRequest, type CameraResponse } from './messages.ts';

(() => {
  const md = navigator.mediaDevices;
  if (!md || typeof md.getUserMedia !== 'function' || (md.getUserMedia as { liveseal?: boolean }).liveseal) return;
  const original = md.getUserMedia.bind(md);
  const pending = new Map<string, (r: CameraResponse) => void>();

  window.addEventListener(EV_RESPONSE, (e) => {
    try {
      const r = JSON.parse((e as CustomEvent<string>).detail) as CameraResponse;
      pending.get(r.id)?.(r);
      pending.delete(r.id);
    } catch {
      // not ours
    }
  });

  function ask(video: MediaTrackConstraints | true): Promise<CameraResponse> {
    const id = `ls${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { pending.delete(id); resolve({ id, ok: false }); }, 15000);
      pending.set(id, (r) => { clearTimeout(timer); resolve(r); });
      const req: CameraRequest = { id, video };
      window.dispatchEvent(new CustomEvent(EV_REQUEST, { detail: JSON.stringify(req) }));
    });
  }

  const wrapped = async function getUserMedia(constraints?: MediaStreamConstraints): Promise<MediaStream> {
    if (!constraints || !constraints.video) return original(constraints);
    const reply = await ask(constraints.video === true ? true : constraints.video);
    if (!reply.ok || !reply.element) return original(constraints);
    const el = document.getElementById(reply.element) as (HTMLCanvasElement & HTMLVideoElement) | null;
    let sealed: MediaStream | null = null;
    if (el && reply.stream && el.srcObject instanceof MediaStream) sealed = el.srcObject;
    else if (el && typeof el.captureStream === 'function') sealed = el.captureStream(30);
    const track = sealed?.getVideoTracks()[0];
    if (!track) {
      window.dispatchEvent(new CustomEvent(EV_STOP, { detail: JSON.stringify({ id: reply.id }) }));
      return original(constraints);
    }
    // make the track look like the camera it came from, for call apps that inspect it
    const settings = reply.settings ?? {};
    const realStop = track.stop.bind(track);
    const realSettings = track.getSettings.bind(track);
    try {
      Object.defineProperty(track, 'label', { get: () => reply.label ?? 'LiveSeal camera' });
      track.getSettings = () => ({ ...realSettings(), ...settings });
      track.applyConstraints = async (c?: MediaTrackConstraints) => {
        window.dispatchEvent(new CustomEvent(EV_APPLY, { detail: JSON.stringify({ id: reply.id, constraints: c ?? {} }) }));
      };
      track.stop = () => {
        realStop();
        window.dispatchEvent(new CustomEvent(EV_STOP, { detail: JSON.stringify({ id: reply.id }) }));
      };
    } catch {
      // some browsers lock these properties; the stream still works
    }
    const out = new MediaStream([track]);
    if (constraints.audio) {
      try {
        const audio = await original({ audio: constraints.audio });
        for (const t of audio.getAudioTracks()) out.addTrack(t);
      } catch (err) {
        track.stop();
        throw err;
      }
    }
    return out;
  };
  (wrapped as { liveseal?: boolean }).liveseal = true;
  md.getUserMedia = wrapped;
})();
