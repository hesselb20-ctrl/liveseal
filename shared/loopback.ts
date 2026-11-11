// A real WebRTC call inside one page: two RTCPeerConnections joined to each
// other. The video goes through the browser's real encoder, packetiser,
// jitter buffer and decoder, with the codec and bitrate we choose. It is not
// a call across a network, and EVALUATION.md reports it as "browser loop-back".

export type CodecChoice = 'VP8' | 'VP9' | 'H264' | 'AV1';

export interface CallStats {
  kbps: number;
  codec: string;
  encoder: string;
  width: number;
  height: number;
  fps: number;
  /** Mean quantiser of recently encoded frames, when the browser reports it. */
  qp: number;
  limitation: string;
}

export class LoopbackCall {
  private pc1: RTCPeerConnection | null = null;
  private pc2: RTCPeerConnection | null = null;
  private sender: RTCRtpSender | null = null;
  private lastBytes = 0;
  private lastTime = 0;
  private lastQp = 0;
  private lastFrames = 0;

  /** Connects and resolves with the stream as the far end receives it. */
  async start(track: MediaStreamTrack, codec: CodecChoice, maxKbps: number): Promise<MediaStream> {
    this.stop();
    const pc1 = new RTCPeerConnection();
    const pc2 = new RTCPeerConnection();
    this.pc1 = pc1;
    this.pc2 = pc2;
    pc1.onicecandidate = (e) => { if (e.candidate) void pc2.addIceCandidate(e.candidate); };
    pc2.onicecandidate = (e) => { if (e.candidate) void pc1.addIceCandidate(e.candidate); };
    const remote = new Promise<MediaStream>((resolve) => {
      pc2.ontrack = (e) => resolve(e.streams[0] ?? new MediaStream([e.track]));
    });
    const transceiver = pc1.addTransceiver(track, { direction: 'sendonly', streams: [new MediaStream([track])] });
    this.sender = transceiver.sender;
    const caps = RTCRtpSender.getCapabilities?.('video');
    if (caps && typeof transceiver.setCodecPreferences === 'function') {
      const wanted = caps.codecs.filter((c) => c.mimeType.toLowerCase() === `video/${codec.toLowerCase()}`);
      if (wanted.length === 0) throw new Error(`${codec} is not available in this browser`);
      // keep retransmission and error-correction formats so the call behaves normally
      const helpers = caps.codecs.filter((c) => /rtx|red|ulpfec|flexfec/i.test(c.mimeType));
      transceiver.setCodecPreferences([...wanted, ...helpers]);
    }
    const offer = await pc1.createOffer();
    await pc1.setLocalDescription(offer);
    await pc2.setRemoteDescription(offer);
    const answer = await pc2.createAnswer();
    await pc2.setLocalDescription(answer);
    await pc1.setRemoteDescription(answer);
    await this.setBitrate(maxKbps);
    return remote;
  }

  async setBitrate(maxKbps: number): Promise<void> {
    if (!this.sender) return;
    const params = this.sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
    params.encodings[0].maxBitrate = maxKbps * 1000;
    await this.sender.setParameters(params);
  }

  /** Swaps the outgoing picture without renegotiating (used to switch between genuine and attack streams). */
  async replaceTrack(track: MediaStreamTrack): Promise<void> {
    await this.sender?.replaceTrack(track);
  }

  async stats(): Promise<CallStats | null> {
    if (!this.pc1) return null;
    const report = await this.pc1.getStats();
    let out: CallStats | null = null;
    const codecs = new Map<string, string>();
    report.forEach((s) => { if (s.type === 'codec') codecs.set(s.id, s.mimeType); });
    report.forEach((s) => {
      if (s.type !== 'outbound-rtp' || s.kind !== 'video') return;
      const now = s.timestamp as number;
      const bytes = s.bytesSent as number;
      const kbps = this.lastTime ? ((bytes - this.lastBytes) * 8) / (now - this.lastTime) : 0;
      const frames = (s.framesEncoded as number) ?? 0;
      const qpSum = (s.qpSum as number) ?? 0;
      const qp = frames > this.lastFrames ? (qpSum - this.lastQp) / (frames - this.lastFrames) : 0;
      this.lastBytes = bytes;
      this.lastTime = now;
      this.lastQp = qpSum;
      this.lastFrames = frames;
      out = {
        kbps: Math.round(kbps),
        codec: codecs.get(s.codecId as string) ?? '',
        encoder: (s.encoderImplementation as string) ?? '',
        width: (s.frameWidth as number) ?? 0,
        height: (s.frameHeight as number) ?? 0,
        fps: Math.round((s.framesPerSecond as number) ?? 0),
        qp: Math.round(qp),
        limitation: (s.qualityLimitationReason as string) ?? '',
      };
    });
    return out;
  }

  stop(): void {
    this.pc1?.close();
    this.pc2?.close();
    this.pc1 = null;
    this.pc2 = null;
    this.sender = null;
    this.lastTime = 0;
  }
}

/** Codecs this browser can send, in a fixed order. */
export function availableCodecs(): CodecChoice[] {
  const caps = typeof RTCRtpSender !== 'undefined' ? RTCRtpSender.getCapabilities?.('video') : null;
  const all: CodecChoice[] = ['VP8', 'VP9', 'H264', 'AV1'];
  if (!caps) return ['VP8'];
  return all.filter((c) => caps.codecs.some((x) => x.mimeType.toLowerCase() === `video/${c.toLowerCase()}`));
}
