/**
 * Maps a persona's `deviceType` trait onto Playwright context options.
 * Presets are pinned here (rather than pulled from Playwright's device
 * registry by name) so emulation is stable across Playwright upgrades.
 */

import type { BrowserContextOptions } from "playwright";
import type { PersonaArchetype } from "../types/index.js";

export type DeviceType = PersonaArchetype["traits"]["deviceType"];

const DEVICE_PRESETS: Record<DeviceType, BrowserContextOptions> = {
  desktop: {
    viewport: { width: 1280, height: 720 },
    isMobile: false,
    hasTouch: false,
  },
  mobile: {
    // Pixel 7-class device.
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 2.625,
    isMobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  },
  tablet: {
    // iPad-class device (landscape-capable, portrait default).
    viewport: { width: 820, height: 1180 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  },
};

export function contextOptionsForDevice(deviceType: DeviceType): BrowserContextOptions {
  return { ...DEVICE_PRESETS[deviceType] };
}
