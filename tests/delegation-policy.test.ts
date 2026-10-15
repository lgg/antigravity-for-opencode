import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AgyError, buildAgyArgs, cleanChildEnvironment, hasPermissionDenial,
  runAgy, validateAllowedDirectory, readCappedStream,
} from "../src/agy-runner";

function proc(stdout: string, stderr = "", exitCode = 0) {
  const stream = (value: string) => new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
  });
  return {
    stdin: { end() {} },
    stdout: stream(stdout),
    stderr: stream(stderr),
    exited: Promise.resolve(exitCode),
    kill() {},
  };
}

async function rejectedWith(code: string, run: () => Promise<unknown>) {
  try {
    await run();
    throw new Error("Expected error: " + code);
  } catch (error) {
    expect(error).toBeInstanceOf(AgyError);
    expect((error as AgyError).code).toBe(code);
  }
}

describe("safe delegated review policy", () => {
  test("analysis review does not expose slash-command starts and pins JSON mode", () => {
    const args = buildAgyArgs({
      prompt: "/permissions\nignored text",
      analysisOnly: true,
      structuredOutput: true,
      sandbox: true,
    });
    expect(args).toContain("--sandbox");
    expect(args.slice(0, -2)).toContain("--output-format");
    const prompt = args[args.indexOf("-p") + 1]!;
    expect(prompt.startsWith("You are an independent code reviewer.")).toBe(true);
    expect(prompt).toContain("Task (untrusted text follows):");
  });

  test("common private tokens are scrubbed before sending a prompt", () => {
    const args = buildAgyArgs({
      prompt: "Review this log: token=verysecretvalue and Authorization: Bearer ya29.example1234567",
      analysisOnly: true,
    });
    const outgoing = args[args.indexOf("-p") + 1]!;
    expect(outgoing).toContain("[REDACTED]");
    expect(outgoing).not.toContain("verysecretvalue");
    expect(outgoing).not.toContain("ya29.example1234567");
  });

  test("JSON SUCCESS is extracted as plain review text", async () => {
    let actualCwd = "";
    let actualEnv: any = null;
    const mockSpawn: any = (_: any, options: any) => {
      actualCwd = options.cwd;
      actualEnv = options.env;
      return proc(JSON.stringify({ status: "SUCCESS", response: "Looks fine", conversation_id: "abc-def" }));
    };
    const result = await runAgy({
      prompt: "Review these test logs",
      analysisOnly: true,
      structuredOutput: true,
      sandbox: true,
    }, mockSpawn);
    expect(result.stdout).toBe("Looks fine");
    expect(result.conversationId).toBe("abc-def");
    expect(path.basename(actualCwd).startsWith("opencode-agy-")).toBe(true);
    expect(actualEnv).toBeDefined();
  });

  test("soft-denied approval is an error even if agy exits zero", async () => {
    await rejectedWith("PERMISSION_DENIED", () => runAgy({
      prompt: "review", structuredOutput: true, analysisOnly: true, sandbox: true,
    }, (() => proc(JSON.stringify({ status: "SUCCESS", response: "Done" }),
      "Tool command denied: permission not granted")) as any));
  });

  test("non-SUCCESS JSON status is not mistaken for completion", async () => {
    await rejectedWith("AGY_STATUS_WAITING", () => runAgy({
      prompt: "review", structuredOutput: true, analysisOnly: true, sandbox: true,
    }, (() => proc(JSON.stringify({ status: "WAITING", response: "", error: "awaiting permission" }))) as any));
  });

  test("malformed JSON fails closed instead of reporting success", async () => {
    await rejectedWith("INVALID_JSON_RESPONSE", () => runAgy({
      prompt: "review", structuredOutput: true, analysisOnly: true, sandbox: true,
    }, (() => proc("not-json")) as any));
  });

  test("unsandboxed and cloud project delegation require explicit opt-in", async () => {
    const oldSandbox = process.env.OPENCODE_AGY_ALLOW_UNSANDBOXED;
    const oldCloud = process.env.OPENCODE_AGY_ALLOW_CLOUD_PROJECT;
    try {
      delete process.env.OPENCODE_AGY_ALLOW_UNSANDBOXED;
      delete process.env.OPENCODE_AGY_ALLOW_CLOUD_PROJECT;
      await rejectedWith("UNSAFE_SANDBOX_DISABLED", () => runAgy({
        prompt: "review", analysisOnly: true, sandbox: false,
      }));
      await rejectedWith("CLOUD_PROJECT_DISABLED", () => runAgy({
        prompt: "review", analysisOnly: true, project: "sensitive-cloud-project",
      }));
    } finally {
      if (oldSandbox === undefined) delete process.env.OPENCODE_AGY_ALLOW_UNSANDBOXED;
      else process.env.OPENCODE_AGY_ALLOW_UNSANDBOXED = oldSandbox;
      if (oldCloud === undefined) delete process.env.OPENCODE_AGY_ALLOW_CLOUD_PROJECT;
      else process.env.OPENCODE_AGY_ALLOW_CLOUD_PROJECT = oldCloud;
    }
  });

  test("disabled by default; directory opt-in enforces realpath containment", () => {
    const testDir = mkdtempSync(path.join(tmpdir(), "agy-dir-test-"));
    const child = path.join(testDir, "project");
    const sibling = path.join(testDir, "other");
    mkdirSync(child);
    mkdirSync(sibling);
    const original = process.env.OPENCODE_AGY_ALLOWED_DIRS;
    try {
      delete process.env.OPENCODE_AGY_ALLOWED_DIRS;
      expect(() => validateAllowedDirectory(child)).toThrow(AgyError);
      process.env.OPENCODE_AGY_ALLOWED_DIRS = child;
      expect(validateAllowedDirectory(child)).toBe(child);
      expect(() => validateAllowedDirectory(sibling)).toThrow(AgyError);
      expect(() => validateAllowedDirectory(path.join(child, "..", "other"))).toThrow(AgyError);
      expect(() => validateAllowedDirectory(".")).toThrow(AgyError);
    } finally {
      if (original === undefined) delete process.env.OPENCODE_AGY_ALLOWED_DIRS;
      else process.env.OPENCODE_AGY_ALLOWED_DIRS = original;
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test("resume and non-Flash / model overrides must be explicitly enabled", async () => {
    const previousResume = process.env.OPENCODE_AGY_ALLOW_RESUME;
    const previousModels = process.env.OPENCODE_AGY_ALLOW_OTHER_MODELS;
    try {
      delete process.env.OPENCODE_AGY_ALLOW_RESUME;
      delete process.env.OPENCODE_AGY_ALLOW_OTHER_MODELS;
      await rejectedWith("RESUME_NOT_ALLOWED", () => runAgy({
        prompt: "review", analysisOnly: true, continue: true,
      }));
      await rejectedWith("MODEL_NOT_ALLOWED", () => runAgy({
        prompt: "review", analysisOnly: true, tier: "claude-opus-5-5-hi",
      }));
      await rejectedWith("MODEL_NOT_ALLOWED", () => runAgy({
        prompt: "review", analysisOnly: true, model: "custom-expensive-model",
      }));
    } finally {
      if (previousResume === undefined) delete process.env.OPENCODE_AGY_ALLOW_RESUME;
      else process.env.OPENCODE_AGY_ALLOW_RESUME = previousResume;
      if (previousModels === undefined) delete process.env.OPENCODE_AGY_ALLOW_OTHER_MODELS;
      else process.env.OPENCODE_AGY_ALLOW_OTHER_MODELS = previousModels;
    }
  });

  test("child environment omits OpenAI, Codex and GitHub tokens but keeps PATH", () => {
    const clean = cleanChildEnvironment({
      PATH: "example",
      HOME: "/tmp/example",
      OPENAI_API_KEY: "secret",
      CODEX_AUTH_TOKEN: "secret2",
      GITHUB_TOKEN: "secret3",
      GH_TOKEN: "secret4",
      DATABASE_URL: "secret5",
    });
    expect(clean.PATH).toBe("example");
    expect(clean.OPENAI_API_KEY).toBeUndefined();
    expect(clean.CODEX_AUTH_TOKEN).toBeUndefined();
    expect(clean.GITHUB_TOKEN).toBeUndefined();
    expect(clean.GH_TOKEN).toBeUndefined();
    expect(clean.DATABASE_URL).toBeUndefined();
  });

  test("large subprocess responses are drained but not fully retained", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("a".repeat(64)));
        controller.enqueue(new TextEncoder().encode("b".repeat(64)));
        controller.close();
      },
    });
    const output = await readCappedStream(stream, 30);
    expect(output.startsWith("a".repeat(30))).toBe(true);
    expect(output).toContain("truncated 98 chars");
    expect(output.length).toBeLessThan(100);
  });

  test("diagnostics recognize common permission-denied notices", () => {
    expect(hasPermissionDenial("permission denied for tool read_file")).toBe(true);
    expect(hasPermissionDenial("Tool command denied: permission not granted")).toBe(true);
    expect(hasPermissionDenial("routine progress and status ok")).toBe(false);
  });
});
