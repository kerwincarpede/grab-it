/**
 * A stand-in for `navigator.mediaDevices` in tests: jsdom has none. Returns
 * what it was asked and a function that takes it away again.
 */
export interface FakeMedia {
  /** The constraints `getUserMedia` was called with, in order. */
  requests: MediaStreamConstraints[];
  /** How many tracks were stopped. */
  stopped: number;
  /** Puts `navigator.mediaDevices` back as it was. */
  restore: () => void;
}

export interface FakeMediaOptions {
  /** What `enumerateDevices` lists, before and after a camera was opened. */
  devices?: Partial<MediaDeviceInfo>[];
  devicesAfterOpen?: Partial<MediaDeviceInfo>[];
  /** Makes `getUserMedia` fail, for a request matching `when` (every one by default). */
  fail?: { name: string; when?: (constraints: MediaStreamConstraints) => boolean };
}

export function fakeMedia({ devices = [], devicesAfterOpen, fail }: FakeMediaOptions = {}): FakeMedia {
  const fake: FakeMedia = { requests: [], stopped: 0, restore: () => undefined };
  let opened = false;
  const previous = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  const mediaDevices = {
    enumerateDevices: () => Promise.resolve((opened && devicesAfterOpen ? devicesAfterOpen : devices) as MediaDeviceInfo[]),
    getUserMedia: (constraints: MediaStreamConstraints) => {
      fake.requests.push(constraints);
      if (fail && (fail.when === undefined || fail.when(constraints))) {
        return Promise.reject(Object.assign(new Error(fail.name), { name: fail.name }));
      }
      opened = true;
      const track = { stop: () => (fake.stopped += 1) };
      return Promise.resolve({ getTracks: () => [track] } as unknown as MediaStream);
    },
  };
  Object.defineProperty(navigator, "mediaDevices", { value: mediaDevices, configurable: true });
  fake.restore = () => {
    if (previous) Object.defineProperty(navigator, "mediaDevices", previous);
    else delete (navigator as { mediaDevices?: unknown }).mediaDevices;
  };
  return fake;
}

export function camera(deviceId: string, label: string): Partial<MediaDeviceInfo> {
  return { kind: "videoinput", deviceId, label, groupId: "" };
}
