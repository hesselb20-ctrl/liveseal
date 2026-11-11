// Messages between the parts of the extension, and the names of the DOM
// events that connect the page-world shim to the isolated content script.

import type { DirectorySnapshot } from '../../core/src/directory.ts';

export interface Settings {
  /** Seal the camera on call sites. */
  seal: boolean;
  strength: 'default' | 'light';
  /** Check incoming video and show badges. */
  verify: boolean;
}

export const DEFAULT_SETTINGS: Settings = { seal: true, strength: 'default', verify: true };

export interface StateReply {
  identity: { name: string; publicKey: string; software: boolean } | null;
  directory: DirectorySnapshot;
  settings: Settings;
}

export type Request =
  | { type: 'state' }
  | { type: 'sign'; data: string }
  | { type: 'record-call'; name: string; sealed: boolean }
  | { type: 'fetch-org'; input: string };

/** Events on `window`. Their `detail` is always a JSON string: objects do not cross between script worlds. */
export const EV_REQUEST = 'liveseal:camera-request';
export const EV_RESPONSE = 'liveseal:camera-response';
export const EV_STOP = 'liveseal:camera-stop';
export const EV_APPLY = 'liveseal:camera-apply';

export interface CameraRequest {
  id: string;
  video: MediaTrackConstraints | true;
}

export interface CameraResponse {
  id: string;
  ok: boolean;
  /** id of the <canvas> (or <video>) element that carries the sealed picture */
  element?: string;
  /** true when the element is a <video> whose srcObject already is the sealed stream */
  stream?: boolean;
  label?: string;
  settings?: MediaTrackSettings;
}

/** Hosts where the extension is active out of the box. */
export const CALL_SITES = [
  'https://meet.google.com/*',
  'https://teams.microsoft.com/*',
  'https://teams.live.com/*',
  'https://*.zoom.us/*',
  'https://meet.jit.si/*',
  'https://8x8.vc/*',
];
