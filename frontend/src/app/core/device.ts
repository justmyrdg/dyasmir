// What the quiz screen tells the server about this device, as the `X-Device` header on /api/attempts/* requests
// (read by backend src/attempts/device.ts). The User-Agent header already carries the browser and OS.

const ID_KEY = 'device-id';

interface DeviceHeader {
  /** Random id kept in this browser, so the teacher can tell devices apart (and see two accounts on one). */
  id?: string;
  /** Physical pixels, larger side first, so rotating a phone or zooming the page does not change it. */
  screen: string;
  touch: boolean;
  /** Chromium only: phone model and OS version (tells Windows 11 from 10). */
  model?: string;
  platformVersion?: string;
}

function browserId(): string | undefined {
  try {
    let id = localStorage.getItem(ID_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(ID_KEY, id);
    }
    return id;
  } catch {
    return undefined;
  }
}

const dpr = window.devicePixelRatio || 1;
const [w, h] = [Math.round(screen.width * dpr), Math.round(screen.height * dpr)];
const info: DeviceHeader = {
  id: browserId(),
  screen: `${Math.max(w, h)}x${Math.min(w, h)}`,
  touch: navigator.maxTouchPoints > 0,
};
let value = encodeURIComponent(JSON.stringify(info));

interface UserAgentData {
  getHighEntropyValues(hints: string[]): Promise<{ model?: string; platformVersion?: string }>;
}
const uaData = (navigator as Navigator & { userAgentData?: UserAgentData }).userAgentData;
uaData
  ?.getHighEntropyValues(['model', 'platformVersion'])
  .then(({ model, platformVersion }) => {
    if (model) info.model = model;
    if (platformVersion) info.platformVersion = platformVersion;
    value = encodeURIComponent(JSON.stringify(info));
  })
  .catch(() => undefined);

export const DEVICE_HEADER = 'X-Device';

/** The current `X-Device` header value (ASCII-safe). */
export function deviceHeader(): string {
  return value;
}
