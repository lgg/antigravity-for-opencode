import { describe, test, expect } from "bun:test";
import { runAgy, AgyError } from "../src/agy-runner";

describe("Unattended delegation boundaries", () => {
  test("yolo=true is blocked by default before spawning agy", async () => {
    const old = process.env.OPENCODE_AGY_ALLOW_YOLO;
    delete process.env.OPENCODE_AGY_ALLOW_YOLO;
    let spawned = false;
    try {
      const spawnFn: any = () => {
        spawned = true;
        throw new Error("should never be called");
      };
      try {
        await runAgy({ prompt: "test", yolo: true }, spawnFn);
        throw new Error("Expected safety error");
      } catch (error) {
        expect(error).toBeInstanceOf(AgyError);
        expect((error as AgyError).code).toBe("UNSAFE_PERMISSIONS_DISABLED");
      }
      expect(spawned).toBe(false);
    } finally {
      if (old === undefined) delete process.env.OPENCODE_AGY_ALLOW_YOLO;
      else process.env.OPENCODE_AGY_ALLOW_YOLO = old;
    }
  });

  test("secrets in returned stdout are redacted", async () => {
    const fakeProc: any = {
      stdin: { end() {} },
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("ok token=verysecretvalue"));
          controller.close();
        },
      }),
      stderr: new ReadableStream({
        start(controller) { controller.close(); },
      }),
      exited: Promise.resolve(0),
      kill() {},
    };
    const result = await runAgy({ prompt: "test" }, (() => fakeProc) as any);
    expect(result.stdout).toContain("[REDACTED]");
    expect(result.stdout).not.toContain("verysecretvalue");
  });

  test("OpenCode 2 default export is an object and V1 remains separate", async () => {
    const v2 = await import("../src/index");
    const v1 = await import("../src/v1");
    expect(typeof v2.default).toBe("object");
    expect(v2.default.id).toBe("opencode-agy");
    expect(typeof v2.default.setup).toBe("function");
    expect(typeof v1.default).toBe("function");
  });
});
