import type { DeviceSummary } from './models';

// How the teacher pages describe a student's device (attempt page, Online now).

export function deviceIcon(d: DeviceSummary) {
  return d.deviceType === 'computer' ? '💻' : '📱';
}

/** "Phone (SM-A546E) · Android 13 · Chrome 141" */
export function deviceTitle(d: DeviceSummary) {
  const kind = { phone: 'Phone', tablet: 'Tablet', computer: 'Computer' }[d.deviceType];
  return [d.model ? `${kind} (${d.model})` : kind, d.os, d.browser].join(' · ');
}

/** "screen 1920×1080 · no touch screen · IP 1.2.3.4" */
export function deviceSpecs(d: DeviceSummary) {
  return [
    d.screen ? `screen ${d.screen.replace('x', '×')}` : null,
    d.touch === null ? null : d.touch ? 'touch screen' : 'no touch screen',
    d.ip ? `IP ${d.ip}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}
