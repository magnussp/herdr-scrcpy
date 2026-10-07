// Device selection: which phone to mirror, and the picker drawn inside the
// mirror pane when several are connected (or when the user presses Ctrl+D).
// Kept free of I/O so it can be unit tested.
import type { Device } from "./scrcpy";
import { term } from "./terminal";

export type DeviceChoice = { serial: string } | { pick: true } | { wait: string };

/**
 * Decides what to mirror from the current `adb devices` list. An explicit
 * choice made in the picker wins over the configured serial; with neither, a
 * single ready phone is used directly and several open the picker.
 */
export function chooseDevice(devices: Device[], opts: { configured?: string; chosen?: string | null }): DeviceChoice {
  const ready = devices.filter((d) => d.state === "device");
  const isReady = (serial: string) => ready.some((d) => d.serial === serial);
  if (opts.chosen && isReady(opts.chosen)) return { serial: opts.chosen };
  if (opts.configured) {
    return isReady(opts.configured)
      ? { serial: opts.configured }
      : { wait: `device ${opts.configured} (serial in config) is not connected` };
  }
  if (ready.length === 1) return { serial: ready[0].serial };
  if (ready.length > 1) return { pick: true };
  return devices.some((d) => d.state === "unauthorized")
    ? { wait: "phone not authorized: accept the USB debugging prompt on the phone" }
    : { wait: "no phone connected" };
}

export function deviceLabel(d: Device): string {
  return d.model ? `${d.model} (${d.serial})` : d.serial;
}

/** 0-based screen row of the first device line. */
const FIRST_ROW = 2;

export class DevicePicker {
  devices: Device[] = [];
  index = 0;

  /**
   * `manual`: opened with Ctrl+D (Esc returns to the running mirror) rather than
   * because several phones were found. `preferred` is preselected when present.
   */
  constructor(
    readonly manual: boolean,
    private preferred: string | null = null,
  ) {}

  /** Replaces the list (devices come and go), keeping the selection on the same phone if possible. */
  setDevices(devices: Device[]) {
    const current = this.devices[this.index]?.serial ?? this.preferred;
    this.devices = devices;
    const same = devices.findIndex((d) => d.serial === current);
    const firstReady = devices.findIndex((d) => d.state === "device");
    this.index = same >= 0 ? same : Math.max(0, firstReady);
  }

  move(delta: number) {
    const n = this.devices.length;
    if (n) this.index = (((this.index + delta) % n) + n) % n;
  }

  select(index: number): boolean {
    if (index < 0 || index >= this.devices.length) return false;
    this.index = index;
    return true;
  }

  /** The selected phone if it can be mirrored (ready, not unauthorized or offline). */
  chosen(): Device | null {
    const d = this.devices[this.index];
    return d && d.state === "device" ? d : null;
  }

  /** Device index for a 1-based terminal row (SGR mouse coordinates), or null. */
  rowAt(y: number): number | null {
    const i = y - 1 - FIRST_ROW;
    return i >= 0 && i < this.devices.length ? i : null;
  }

  /** Full-screen picker (everything above the status line). */
  render(cols: number): string {
    const fit = (s: string) => s.slice(0, Math.max(0, cols));
    let out = term.clear + term.moveTo(0, 0) + `\x1b[1m${fit(" Choose a device to mirror")}\x1b[0m`;
    if (!this.devices.length) {
      return out + term.moveTo(FIRST_ROW, 0) + fit("   No phones connected. Plug one in with USB debugging enabled.");
    }
    this.devices.forEach((d, i) => {
      const selected = i === this.index;
      const note =
        d.state === "device" ? "" : d.state === "unauthorized" ? "  unauthorized: accept the prompt on the phone" : `  ${d.state}`;
      const text = fit(` ${selected ? "›" : " "} ${i + 1}. ${deviceLabel(d)}${note}`);
      const style = d.state !== "device" ? "\x1b[2m" : selected ? "\x1b[7m" : "";
      out += term.moveTo(FIRST_ROW + i, 0) + style + text + "\x1b[0m";
    });
    const hint = `↑/↓ or 1-9 to select · Enter or click to mirror${this.manual ? " · Esc to go back" : ""}`;
    return out + term.moveTo(FIRST_ROW + this.devices.length + 1, 0) + `\x1b[2m${fit("   " + hint)}\x1b[0m`;
  }
}
