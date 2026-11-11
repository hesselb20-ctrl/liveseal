// On-device face detection with MediaPipe Tasks (WASM). The model and the
// WASM runtime are served from this site (see scripts/vendor.ts), so nothing
// is fetched from a third party at run time. If they are missing or fail to
// load, sealing continues with a fixed central box.

export type FaceBoxFractions = [number, number, number, number];
export type FaceDetect = (video: HTMLVideoElement) => FaceBoxFractions | null;

interface Detection {
  boundingBox?: { originX: number; originY: number; width: number; height: number };
}

/**
 * Loads the detector. `base` is the URL of the folder that holds `wasm/` and
 * the model file. Resolves with null when the detector is not available.
 */
export async function loadFaceDetector(base: string): Promise<FaceDetect | null> {
  try {
    const head = await fetch(`${base}/blaze_face_short_range.tflite`, { method: 'HEAD' });
    if (!head.ok) return null;
    const vision = await import('@mediapipe/tasks-vision');
    const fileset = await vision.FilesetResolver.forVisionTasks(`${base}/wasm`);
    const detector = await vision.FaceDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: `${base}/blaze_face_short_range.tflite`, delegate: 'CPU' },
      runningMode: 'VIDEO',
      minDetectionConfidence: 0.5,
    });
    let smoothed: FaceBoxFractions | null = null;
    return (video) => {
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (!w || !h) return null;
      const result = detector.detectForVideo(video, performance.now()) as { detections: Detection[] };
      let best: Detection['boundingBox'] | null = null;
      for (const d of result.detections) {
        const b = d.boundingBox;
        if (b && (!best || b.width * b.height > best.width * best.height)) best = b;
      }
      if (!best) return smoothed;
      // the detector frames the face tightly; widen it to take in forehead and chin
      const pad = 0.18;
      const x = Math.max(0, best.originX / w - (pad * best.width) / w);
      const y = Math.max(0, best.originY / h - (1.6 * pad * best.height) / h);
      const bw = Math.min(1 - x, (best.width * (1 + 2 * pad)) / w);
      const bh = Math.min(1 - y, (best.height * (1 + 2.6 * pad)) / h);
      const next: FaceBoxFractions = [x, y, bw, bh];
      // follow slowly: the box is signed once per period, so it should not jitter
      smoothed = smoothed ? (smoothed.map((v, i) => v + 0.35 * (next[i] - v)) as FaceBoxFractions) : next;
      return smoothed;
    };
  } catch {
    return null;
  }
}
