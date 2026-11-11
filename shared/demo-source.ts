// Video sources for the demo pages: the camera, a video file, or a drawn
// stand-in "person" for visitors who would rather not turn their camera on.

export interface VideoSource {
  video: HTMLVideoElement;
  label: string;
  stop(): void;
}

async function playing(video: HTMLVideoElement): Promise<HTMLVideoElement> {
  video.muted = true;
  video.playsInline = true;
  // Browsers only deliver per-frame callbacks for videos that are painted, so the
  // source sits in the page as a two-pixel, nearly transparent element.
  video.setAttribute('aria-hidden', 'true');
  video.tabIndex = -1;
  Object.assign(video.style, { position: 'fixed', left: '0', bottom: '0', width: '2px', height: '2px', opacity: '0.01', pointerEvents: 'none' });
  document.body.append(video);
  await video.play();
  if (!video.videoWidth) {
    await new Promise<void>((resolve) => video.addEventListener('loadedmetadata', () => resolve(), { once: true }));
  }
  return video;
}

export async function cameraSource(width = 1280, height = 720): Promise<VideoSource> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: 30 } },
    audio: false,
  });
  const video = document.createElement('video');
  video.srcObject = stream;
  await playing(video);
  return { video, label: 'Camera', stop: () => { stream.getTracks().forEach((t) => t.stop()); video.remove(); } };
}

export async function fileSource(url: string): Promise<VideoSource> {
  const video = document.createElement('video');
  video.src = url;
  video.loop = true;
  video.crossOrigin = 'anonymous';
  await playing(video);
  return { video, label: 'Video file', stop: () => { video.pause(); video.removeAttribute('src'); video.load(); video.remove(); } };
}

interface Person {
  skin: string;
  hair: string;
  shirt: string;
  eye: number;
  mouth: number;
  wall: [string, string];
}

const PEOPLE: Person[] = [
  { skin: '#e2b08c', hair: '#3a2a1e', shirt: '#2f5d8a', eye: 0.36, mouth: 0.42, wall: ['#b9c6d2', '#8fa3b5'] },
  { skin: '#9a6a4b', hair: '#101010', shirt: '#7a2f3b', eye: 0.3, mouth: 0.55, wall: ['#cfc4a8', '#a3987a'] },
];

/**
 * A drawn talking head on a canvas, 640x360 at 30 fps. `who` selects one of
 * two different-looking characters, so the demo can swap one for the other.
 */
export async function drawnSource(who = 0): Promise<VideoSource> {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 360;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  const p = PEOPLE[who % PEOPLE.length];
  // a fixed, irregular background: shelves and a plant, so the picture is not flat
  const bg = document.createElement('canvas');
  bg.width = 640;
  bg.height = 360;
  const b = bg.getContext('2d') as CanvasRenderingContext2D;
  const grad = b.createLinearGradient(0, 0, 640, 360);
  grad.addColorStop(0, p.wall[0]);
  grad.addColorStop(1, p.wall[1]);
  b.fillStyle = grad;
  b.fillRect(0, 0, 640, 360);
  let seed = 17 + who * 101;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let shelf = 0; shelf < 3; shelf++) {
    const y = 40 + shelf * 78;
    b.fillStyle = 'rgba(60,45,30,0.55)';
    b.fillRect(20, y + 52, 250 + who * 60, 6);
    let x = 26;
    while (x < 250 + who * 60) {
      const w = 8 + rnd() * 16;
      const h = 30 + rnd() * 22;
      b.fillStyle = `hsl(${Math.floor(rnd() * 360)} ${30 + rnd() * 30}% ${30 + rnd() * 35}%)`;
      b.fillRect(x, y + 52 - h, w, h);
      x += w + 2;
    }
  }
  b.fillStyle = '#2f6b3d';
  for (let i = 0; i < 9; i++) {
    b.beginPath();
    b.ellipse(560 + rnd() * 50 - 25, 200 + rnd() * 90, 14 + rnd() * 10, 34 + rnd() * 16, rnd() * 3, 0, Math.PI * 2);
    b.fill();
  }
  b.fillStyle = '#7b4a2a';
  b.fillRect(538, 300, 46, 60);

  let raf = 0;
  let stopped = false;
  const start = performance.now();
  const draw = () => {
    if (stopped) return;
    const t = (performance.now() - start) / 1000;
    ctx.drawImage(bg, 0, 0);
    const cx = 320 + 9 * Math.sin(t * 0.9);
    const cy = 150 + 4 * Math.sin(t * 1.3);
    // shoulders
    ctx.fillStyle = p.shirt;
    ctx.beginPath();
    ctx.ellipse(cx, 392, 190, 130, 0, 0, Math.PI * 2);
    ctx.fill();
    // neck and head
    ctx.fillStyle = p.skin;
    ctx.fillRect(cx - 28, cy + 70, 56, 60);
    ctx.beginPath();
    ctx.ellipse(cx, cy, 78, 100, 0, 0, Math.PI * 2);
    ctx.fill();
    // hair
    ctx.fillStyle = p.hair;
    ctx.beginPath();
    ctx.ellipse(cx, cy - 50, 84, 62, 0, Math.PI, Math.PI * 2);
    ctx.fill();
    // eyes, with an occasional blink
    const blink = Math.sin(t * 2.3) > 0.97 ? 0.15 : 1;
    ctx.fillStyle = '#1c1c1c';
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(cx + side * 78 * p.eye, cy - 14, 9, 7 * blink, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillRect(cx + side * 78 * p.eye - 14, cy - 36, 28, 4);
    }
    // nose and a talking mouth
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(cx - 4, cy - 2, 8, 26);
    const open = 3 + 13 * Math.abs(Math.sin(t * 5.1));
    ctx.fillStyle = '#5a1f25';
    ctx.beginPath();
    ctx.ellipse(cx, cy + 50, 78 * p.mouth * 0.5, open, 0, 0, Math.PI * 2);
    ctx.fill();
    raf = requestAnimationFrame(draw);
  };
  draw();
  const stream = canvas.captureStream(30);
  const video = document.createElement('video');
  video.srcObject = stream;
  await playing(video);
  return {
    video,
    label: who === 0 ? 'Drawn stand-in' : 'Drawn impostor',
    stop: () => {
      stopped = true;
      cancelAnimationFrame(raf);
      stream.getTracks().forEach((t) => t.stop());
      video.remove();
    },
  };
}
