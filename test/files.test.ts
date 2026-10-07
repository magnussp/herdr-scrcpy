import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFrameDir, createLogger } from "../src/files";

const scratch = mkdtempSync(join(tmpdir(), "herdr-scrcpy-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

test("the log is rotated once it passes 1 MiB", () => {
  const path = join(scratch, "mirror.log");
  writeFileSync(path, "x".repeat(1100 * 1024));
  createLogger(path)("hello");
  expect(existsSync(`${path}.1`)).toBe(true);
  expect(statSync(path).size).toBeLessThan(200);
});

test("frame directories are private and dead mirrors' directories are swept", () => {
  const stale = join(tmpdir(), "tty-graphics-protocol-scrcpy-999999-test");
  mkdirSync(stale, { recursive: true });
  const dir = createFrameDir();
  try {
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(dir).toContain(`tty-graphics-protocol-scrcpy-${process.pid}-`);
    expect(existsSync(stale)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
