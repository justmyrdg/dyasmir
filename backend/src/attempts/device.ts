import { createHash } from 'node:crypto';
import type { Request } from 'express';
import type { AuthUser } from '../auth/auth.types';
import { prisma } from '../db';

// Which device a student takes a quiz on. The browser's User-Agent header gives the browser, OS and device type; the
// quiz screen adds an `X-Device` header (URI-encoded JSON, see frontend core/device.ts) with what only the page knows:
// a random per-browser id, the screen size, touch support and, on Chromium, the phone model and Windows version.
// All of it can be faked by a determined student, so the teacher sees it as a clue, not proof.

export interface DeviceInfo {
  deviceKey: string;
  deviceType: 'phone' | 'tablet' | 'computer';
  os: string;
  browser: string;
  model: string | null;
  screen: string | null;
  touch: boolean | null;
  ip: string | null;
  userAgent: string;
}

/** What "Online now" shows of a student's latest request (users.last_device): the device without its key. */
export type OnlineDevice = Omit<DeviceInfo, 'deviceKey'>;

interface ClientHeader {
  id?: unknown;
  screen?: unknown;
  touch?: unknown;
  model?: unknown;
  platformVersion?: unknown;
}

const str = (v: unknown, max: number, pattern: RegExp) =>
  typeof v === 'string' && v.length > 0 && v.length <= max && pattern.test(v) ? v : null;

function readClientHeader(req: Request): ClientHeader {
  const raw = req.get('x-device');
  if (!raw || raw.length > 1000) return {};
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(raw));
    return parsed && typeof parsed === 'object' ? (parsed as ClientHeader) : {};
  } catch {
    return {};
  }
}

const major = (v: string | undefined) => (v ? v.split('.')[0] : '');

function parseBrowser(ua: string): string {
  const m = (re: RegExp) => ua.match(re)?.[1];
  let v: string | undefined;
  if ((v = m(/EdgA?\/([\d.]+)/) ?? m(/EdgiOS\/([\d.]+)/))) return `Edge ${major(v)}`;
  if ((v = m(/OPR\/([\d.]+)/))) return `Opera ${major(v)}`;
  if ((v = m(/SamsungBrowser\/([\d.]+)/))) return `Samsung Internet ${major(v)}`;
  if ((v = m(/(?:Firefox|FxiOS)\/([\d.]+)/))) return `Firefox ${major(v)}`;
  if ((v = m(/CriOS\/([\d.]+)/))) return `Chrome ${major(v)}`;
  if ((v = m(/Chrome\/([\d.]+)/))) return `Chrome ${major(v)}`;
  if ((v = m(/Version\/([\d.]+).*Safari\//))) return `Safari ${major(v)}`;
  return 'Unknown browser';
}

function parseOs(ua: string, platformVersion: string | null, touch: boolean | null): string {
  let m: RegExpMatchArray | null;
  if (/Windows NT 10\.0/.test(ua)) {
    // The UA says "10.0" on Windows 11 too; Chromium's platformVersion is 13+ on Windows 11.
    if (platformVersion) return Number(major(platformVersion)) >= 13 ? 'Windows 11' : 'Windows 10';
    return 'Windows 10/11';
  }
  if ((m = ua.match(/Windows NT ([\d.]+)/))) return `Windows NT ${m[1]}`;
  if ((m = ua.match(/Android ([\d.]+)/))) return `Android ${major(m[1])}`;
  if ((m = ua.match(/(?:iPhone|CPU) OS (\d+)(?:_(\d+))?/))) return `${/iPad/.test(ua) ? 'iPadOS' : 'iOS'} ${m[1]}${m[2] ? '.' + m[2] : ''}`;
  if (/Macintosh/.test(ua)) return touch ? 'iPadOS' : 'macOS'; // iPads ask for desktop sites as a Mac
  if (/CrOS/.test(ua)) return 'ChromeOS';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Unknown OS';
}

function parseDeviceType(ua: string, touch: boolean | null): DeviceInfo['deviceType'] {
  if (/iPad|Tablet/.test(ua) || (/Macintosh/.test(ua) && touch)) return 'tablet';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'phone' : 'tablet';
  if (/iPhone|iPod|Mobi/.test(ua)) return 'phone';
  return 'computer';
}

/** The model from an older Android UA ("Android 13; SM-A546E Build/..."); newer Chrome sends just "K". */
function androidModel(ua: string): string | null {
  const m = ua.match(/Android [\d.]+; (?:[a-z]{2}[-_][a-z]{2}; )?([^;)]+?)(?: Build\/[^;)]*)?[;)]/i);
  const model = m?.[1].trim();
  return model && model !== 'K' && !/^(wv|Mobile|Linux)$/i.test(model) ? model.slice(0, 80) : null;
}

export function deviceFromRequest(req: Request): DeviceInfo {
  const userAgent = (req.get('user-agent') ?? '').slice(0, 500);
  const client = readClientHeader(req);
  const id = str(client.id, 64, /^[A-Za-z0-9-]+$/);
  const screen = str(client.screen, 20, /^\d{1,5}x\d{1,5}$/);
  const touch = typeof client.touch === 'boolean' ? client.touch : null;
  const platformVersion = str(client.platformVersion, 20, /^[\d.]+$/);
  const model = str(client.model, 80, /^[\x20-\x7e]+$/) ?? androidModel(userAgent);
  return {
    deviceKey: id ? `b:${id}` : `ua:${createHash('sha256').update(userAgent).digest('hex')}`,
    deviceType: parseDeviceType(userAgent, touch),
    os: parseOs(userAgent, platformVersion, touch),
    browser: parseBrowser(userAgent),
    model,
    screen,
    touch,
    ip: req.ip ? req.ip.replace(/^::ffff:/, '').slice(0, 45) : null,
    userAgent,
  };
}

export function onlineDeviceFromRequest(req: Request): OnlineDevice {
  const { deviceKey, ...device } = deviceFromRequest(req);
  void deviceKey;
  return device;
}

/**
 * Notes the device behind a request on the student's own attempt while it is in progress (start, resume, save,
 * events). Never fails the request: a lost device row is better than a lost answer.
 */
export async function recordDevice(req: Request, user: AuthUser, attemptId: number): Promise<void> {
  const d = deviceFromRequest(req);
  try {
    await prisma.$executeRaw`
      INSERT INTO attempt_devices (attempt_id, device_key, device_type, os, browser, model, screen, touch, ip, user_agent)
      SELECT at.id, ${d.deviceKey}, ${d.deviceType}, ${d.os}, ${d.browser}, ${d.model}, ${d.screen}, ${d.touch}, ${d.ip}, ${d.userAgent}
      FROM attempts at
      WHERE at.id = ${attemptId} AND at.student_id = ${user.id} AND at.status = 'in_progress'
      ON CONFLICT (attempt_id, device_key) DO UPDATE SET
        last_seen_at = now(),
        device_type = EXCLUDED.device_type,
        -- A request sent before the page read the Windows version must not undo "Windows 11".
        os = CASE WHEN EXCLUDED.os = 'Windows 10/11' AND attempt_devices.os LIKE 'Windows 1%' THEN attempt_devices.os ELSE EXCLUDED.os END,
        browser = EXCLUDED.browser,
        model = COALESCE(EXCLUDED.model, attempt_devices.model),
        screen = COALESCE(EXCLUDED.screen, attempt_devices.screen),
        touch = COALESCE(EXCLUDED.touch, attempt_devices.touch),
        ip = COALESCE(EXCLUDED.ip, attempt_devices.ip),
        user_agent = EXCLUDED.user_agent`;
  } catch (err) {
    console.error('Could not record the device for attempt', attemptId, err);
  }
}
