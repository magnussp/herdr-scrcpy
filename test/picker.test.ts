import { describe, expect, test } from "bun:test";
import { chooseDevice, DevicePicker } from "../src/picker";
import type { Device } from "../src/scrcpy";

const pixel: Device = { serial: "AAA", state: "device", model: "Pixel 10 Pro" };
const galaxy: Device = { serial: "BBB", state: "device", model: "Galaxy S30" };
const locked: Device = { serial: "CCC", state: "unauthorized" };

describe("chooseDevice", () => {
  test("a single ready phone is used directly", () => {
    expect(chooseDevice([pixel, locked], {})).toEqual({ serial: "AAA" });
  });

  test("several ready phones open the picker", () => {
    expect(chooseDevice([pixel, galaxy], {})).toEqual({ pick: true });
  });

  test("a choice from the picker wins over the config", () => {
    expect(chooseDevice([pixel, galaxy], { configured: "AAA", chosen: "BBB" })).toEqual({ serial: "BBB" });
  });

  test("a configured serial is used, or waited for", () => {
    expect(chooseDevice([pixel, galaxy], { configured: "BBB" })).toEqual({ serial: "BBB" });
    expect(chooseDevice([pixel], { configured: "ZZZ" })).toEqual({
      wait: "device ZZZ (serial in config) is not connected",
    });
  });

  test("a disconnected earlier choice falls back to the normal rules", () => {
    expect(chooseDevice([galaxy], { chosen: "AAA" })).toEqual({ serial: "BBB" });
  });

  test("nothing ready: explain what to do", () => {
    expect(chooseDevice([locked], {})).toEqual({
      wait: "phone not authorized: accept the USB debugging prompt on the phone",
    });
    expect(chooseDevice([], {})).toEqual({ wait: "no phone connected" });
  });
});

describe("DevicePicker", () => {
  test("preselects the preferred phone and keeps the selection across refreshes", () => {
    const p = new DevicePicker(false, "BBB");
    p.setDevices([pixel, galaxy]);
    expect(p.chosen()?.serial).toBe("BBB");
    p.setDevices([locked, galaxy, pixel]); // order changed, phone added
    expect(p.chosen()?.serial).toBe("BBB");
  });

  test("starts on the first ready phone without a preference", () => {
    const p = new DevicePicker(false);
    p.setDevices([locked, pixel]);
    expect(p.index).toBe(1);
  });

  test("movement wraps and unauthorized phones can't be chosen", () => {
    const p = new DevicePicker(true);
    p.setDevices([pixel, locked]);
    p.move(-1);
    expect(p.index).toBe(1);
    expect(p.chosen()).toBeNull();
    p.move(1);
    expect(p.chosen()?.serial).toBe("AAA");
    expect(p.select(5)).toBe(false);
  });

  test("mouse rows map to devices", () => {
    const p = new DevicePicker(false);
    p.setDevices([pixel, galaxy]);
    expect(p.rowAt(3)).toBe(0); // 1-based terminal row 3 = first device line
    expect(p.rowAt(4)).toBe(1);
    expect(p.rowAt(2)).toBeNull();
    expect(p.rowAt(5)).toBeNull();
  });

  test("renders models, serials and states", () => {
    const p = new DevicePicker(true);
    p.setDevices([pixel, locked]);
    const screen = p.render(120);
    expect(screen).toContain("1. Pixel 10 Pro (AAA)");
    expect(screen).toContain("2. CCC  unauthorized");
    expect(screen).toContain("Esc to go back");
    expect(new DevicePicker(false).render(120)).toContain("No phones connected");
  });
});
