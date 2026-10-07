import { describe, expect, test } from "bun:test";
import {
  Action, Keycode, keycodeMsg, keyPress, parseDevices, parseVideoHeader, scrollMsg, textMsg, touchMsg,
} from "../src/scrcpy";

describe("control messages", () => {
  test("touch event layout", () => {
    const b = touchMsg(Action.DOWN, 100.4, 200.6, 572, 1280);
    expect(b.length).toBe(32);
    expect(b[0]).toBe(2); // TYPE_INJECT_TOUCH_EVENT
    expect(b[1]).toBe(Action.DOWN);
    expect(b.readBigInt64BE(2)).toBe(-2n); // generic finger
    expect(b.readInt32BE(10)).toBe(100);
    expect(b.readInt32BE(14)).toBe(201);
    expect(b.readUInt16BE(18)).toBe(572);
    expect(b.readUInt16BE(20)).toBe(1280);
    expect(b.readUInt16BE(22)).toBe(0xffff); // full pressure while touching
    expect(b.readInt32BE(24)).toBe(0);
    expect(b.readInt32BE(28)).toBe(0);
  });

  test("touch up has zero pressure", () => {
    expect(touchMsg(Action.UP, 1, 1, 10, 10).readUInt16BE(22)).toBe(0);
  });

  test("scroll uses i16 fixed point over [-16, 16]", () => {
    const b = scrollMsg(10, 20, 572, 1280, 0, 1);
    expect(b.length).toBe(21);
    expect(b[0]).toBe(3);
    expect(b.readInt32BE(1)).toBe(10);
    expect(b.readInt32BE(5)).toBe(20);
    expect(b.readInt16BE(13)).toBe(0);
    expect(b.readInt16BE(15)).toBe(0x0800); // 1/16 of full range
    expect(scrollMsg(0, 0, 1, 1, 0, -1).readInt16BE(15)).toBe(-0x0800);
    expect(scrollMsg(0, 0, 1, 1, 0, 100).readInt16BE(15)).toBe(0x7fff); // clamped
  });

  test("keycode layout and key press pair", () => {
    const b = keycodeMsg(Action.DOWN, Keycode.HOME, 0);
    expect([...b]).toEqual([0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0]);
    const [down, up] = keyPress(Keycode.BACK);
    expect(down[1]).toBe(Action.DOWN);
    expect(up[1]).toBe(Action.UP);
    expect(up.readInt32BE(2)).toBe(Keycode.BACK);
  });

  test("text is UTF-8 with a u32 length, capped at 300 bytes", () => {
    const b = textMsg("hé");
    expect(b[0]).toBe(1);
    expect(b.readUInt32BE(1)).toBe(3);
    expect(b.subarray(5).toString("utf8")).toBe("hé");
    expect(textMsg("x".repeat(400)).readUInt32BE(1)).toBe(300);
  });
});

test("parseDevices reads adb devices -l", () => {
  const out = [
    "List of devices attached",
    "0A1B2C3D4E5F6G         device usb:1-1 product:mustang model:Pixel_10_Pro device:mustang transport_id:3",
    "9Z8Y7X6W5V4U3T         unauthorized usb:1-2 transport_id:4",
    "emulator-5554          offline",
    "",
  ].join("\n");
  expect(parseDevices(out)).toEqual([
    { serial: "0A1B2C3D4E5F6G", state: "device", model: "Pixel 10 Pro" },
    { serial: "9Z8Y7X6W5V4U3T", state: "unauthorized" },
    { serial: "emulator-5554", state: "offline" },
  ]);
  expect(parseDevices("List of devices attached\n\n")).toEqual([]);
});

describe("parseVideoHeader (scrcpy 5)", () => {
  test("session packet", () => {
    const b = Buffer.alloc(12);
    b[0] = 0x80;
    b.writeUInt32BE(572, 4);
    b.writeUInt32BE(1280, 8);
    expect(parseVideoHeader(b)).toEqual({ kind: "session", width: 572, height: 1280 });
  });

  test("media packet with key frame flag and PTS", () => {
    const b = Buffer.alloc(12);
    b.writeBigUInt64BE((1n << 61n) | 123_456n, 0); // key frame + pts
    b.writeUInt32BE(4096, 8);
    expect(parseVideoHeader(b)).toEqual({ kind: "media", config: false, keyFrame: true, pts: 123_456, length: 4096 });
  });

  test("config packet has no PTS", () => {
    const b = Buffer.alloc(12);
    b.writeBigUInt64BE(1n << 62n, 0);
    b.writeUInt32BE(31, 8);
    expect(parseVideoHeader(b)).toEqual({ kind: "media", config: true, keyFrame: false, pts: 0, length: 31 });
  });
});
