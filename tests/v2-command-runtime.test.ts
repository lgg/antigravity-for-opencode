import { describe, expect, test } from "bun:test";
import { setupV2Plugin } from "../src/agy-v2";

describe("OpenCode 2 slash command runtime contract", () => {
  test("/agy is a callable CommandDefinition, preserving session, attachments, and delivery", async () => {
    let command: any;
    let submitted: any;
    const ctx = {
      command: {
        transform: async (register: (editor: any) => void) => {
          register({ add: (definition: any) => { command = definition; } });
        },
      },
      session: {
        prompt: async (data: any) => { submitted = data; },
      },
    };

    await setupV2Plugin(ctx);

    expect(command.name).toBe("agy");
    expect(typeof command.execute).toBe("function");
    expect("template" in command).toBe(false);

    await command.execute({
      sessionID: "ses-test",
      prompt: {
        text: "Is 2 + 2 equal to 4?",
        files: [{ uri: "file:///tmp/sample.txt" }],
      },
      delivery: "queue",
    });

    expect(submitted.sessionID).toBe("ses-test");
    expect(submitted.delivery).toBe("queue");
    expect(submitted.files).toEqual([{ uri: "file:///tmp/sample.txt" }]);
    expect(submitted.text).toContain("Is 2 + 2 equal to 4?");
    expect(submitted.text).toContain("agy");
    expect(submitted.text).not.toContain("$ARGUMENTS");
  });

  test("empty /agy invocation fails explicitly, without queuing a session prompt", async () => {
    let command: any;
    let calls = 0;
    await setupV2Plugin({
      command: { transform: async (fn: any) => fn({ add: (v: any) => command = v }) },
      session: { prompt: async () => { calls++; } },
    });
    await expect(command.execute({
      sessionID: "ses-test",
      prompt: { text: " " },
      delivery: "steer",
    })).rejects.toThrow("Usage: /agy");
    expect(calls).toBe(0);
  });

  test("missing host session API fails with a meaningful error", async () => {
    let command: any;
    await setupV2Plugin({
      command: { transform: async (fn: any) => fn({ add: (v: any) => command = v }) },
    });
    await expect(command.execute({
      sessionID: "ses-test",
      prompt: { text: "review this code" },
      delivery: "steer",
    })).rejects.toThrow("session.prompt API");
  });
});
