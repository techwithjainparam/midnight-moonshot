// PRIESTATE — Browser camera capture layer (Level 3 Part 4).
//
// Obtains the user's webcam ONLY on explicit permission and exposes a tiny
// in-memory greyscale sample of each frame. Guarantees:
//   * camera permission is requested explicitly (`getUserMedia` default prompt),
//   * all tracks are STOPPED when the consumer finishes or the component
//     unmounts — we do not retain camera access continuously,
//   * frames are downsampled to a small grey grid; raw pixels are discarded
//     immediately and never stored, uploaded, logged, or mirrored,
//   * errors map to honest states: permission denied / no camera / unsupported.
//
// This layer is deliberately thin and DOM-bound; all reasoning (motion,
// quality, state machine) lives in the pure vision modules where it can be
// unit-tested without a webcam.

import { GreyFrame } from './vision-provider';

export type CameraErrorKind = 'denied' | 'unavailable' | 'unsupported';

export interface CameraHandle {
  readonly video: HTMLVideoElement;
  /** Stop every track and drop the stream. Safe to call multiple times. */
  readonly stop: () => void;
  /** Capture one grid×grid greyscale sample of the current live frame. */
  readonly sample: (grid: number) => GreyFrame;
}

export function cameraErrorMessage(kind: CameraErrorKind): string {
  switch (kind) {
    case 'denied':
      return 'Camera permission was denied. Allow camera access and try again.';
    case 'unsupported':
      return 'This browser or device does not support camera capture.';
    default:
      return 'No camera is available on this device.';
  }
}

export class CameraUnavailableError extends Error {
  readonly kind: CameraErrorKind;
  constructor(kind: CameraErrorKind) {
    super(cameraErrorMessage(kind));
    this.kind = kind;
    this.name = 'CameraUnavailableError';
  }
}

/**
 * Request the camera with an explicit permission prompt. Throws
 * `CameraUnavailableError` (mapped to the state machine's failure states) when
 * permission is denied, no device is present, or capture is unsupported.
 */
export async function requestCamera(grid = 16): Promise<CameraHandle> {
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
    throw new CameraUnavailableError('unsupported');
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
  } catch (err) {
    throw new CameraUnavailableError(isPermissionError(err) ? 'denied' : 'unavailable');
  }
  const tracks = stream.getTracks();
  if (tracks.length === 0) {
    throw new CameraUnavailableError('unavailable');
  }

  const video = document.createElement('video');
  video.setAttribute('playsinline', '');
  video.setAttribute('autoplay', '');
  video.setAttribute('muted', '');
  video.muted = true;
  video.srcObject = stream;
  void video.play?.();

  const sample = makeSampler(video, grid);
  const stop = () => {
    for (const t of tracks) t.stop();
    video.srcObject = null;
  };

  return { video, stop, sample };
}

function makeSampler(
  video: HTMLVideoElement,
  grid: number,
): (g: number) => GreyFrame {
  const canvas = document.createElement('canvas');
  canvas.width = grid;
  canvas.height = grid;
  return (g: number) => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return Array.from({ length: g * g }, () => 0);
    // Reading dimensions forces the video frame to be decoded/mlaybefore we
    // draw it, so the snapshot reflects the current live frame.
    void video.videoWidth;
    void video.videoHeight;
    ctx.drawImage(video, 0, 0, g, g);
    try {
      const pixels = ctx.getImageData(0, 0, g, g).data;
      const out: number[] = new Array(g * g);
      for (let i = 0; i < g * g; i += 1) {
        const x = i * 4;
        const r = pixels[x];
        const g2 = pixels[x + 1];
        const b = pixels[x + 2];
        out[i] = (0.299 * r + 0.587 * g2 + 0.114 * b) / 255;
      }
      return out;
    } catch {
      return Array.from({ length: g * g }, () => 0);
    }
  };
}

function isPermissionError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: string; code?: string; message?: string };
  const m = `${e.name ?? ''} ${e.code ?? ''} ${e.message ?? ''}`.toLowerCase();
  return m.includes('denied') || m.includes('deny') || m.includes('notallowed');
}