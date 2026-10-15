import { runAgy, AgyError, type AgyResult } from "./agy-runner";
import { createAgyCommand } from "./agy-command";

/**
 * Native JSON Schema for OpenCode 2.x tool registration.
 * Has zero dependency on @opencode-ai/plugin or Zod.
 */
export const AGY_V2_TOOL_SCHEMA = {
  type: "object",
  properties: {
    prompt: {
      type: "string",
      description: "The task to send to agy/Gemini. Be specific and scoped.",
    },
    tier: {
      type: "string",
      enum: [
        "flash-3.8-hi",
        "flash-3.8-med",
        "flash-3.8-lo",
        "claude-sonnet-5-5-hi",
        "claude-sonnet-5-5-med",
        "claude-sonnet-5-5-lo",
        "claude-opus-5-5-hi",
        "claude-opus-5-5-med",
        "claude-opus-5-5-lo",
        "argon-4-hi",
        "argon-4-med",
        "argon-4-lo",
      ],
      description:
        "Model tier. flash-3.8-med (default) = Gemini 3.8 Flash Medium (works on every account). flash-3.8-hi = Gemini 3.8 Flash High, flash-3.8-lo = cheapest Flash. claude-sonnet-5-5-hi/med/lo = Claude Sonnet 5.5 (requires a Pro or Ultra plan). claude-opus-5-5-hi/med/lo = Claude Opus 5.5 (requires a Pro or Ultra plan). argon-4-hi/med/lo = Gemini 4 Argon (Ultra plan only). Gemini 3.6/3.7 Flash and 3.1 Pro tiers were removed upstream (Enterprise-only) and are no longer accepted.",
    },
    dir: {
      type: "string",
      description: "Explicitly approved directory to give agy (--add-dir). Disabled by default; requires OPENCODE_AGY_ALLOWED_DIRS.",
    },
    project: {
      type: "string",
      description: "Project name to pass to agy (--project <value>).",
    },
    timeout: {
      oneOf: [{ type: "string" }, { type: "number" }],
      description:
        "Timeout for agy. Accepts duration strings like '5m', '10m', '300s', or raw milliseconds (e.g. 300000 or 600000). " +
        "Numbers/strings of digits are normalized to proper duration (300000 → '5m'). " +
        "Default: '15m' for every tier. " +
        "Hard upper bound: any value above 4h is silently clamped to '4h'. " +
        "For long tasks (big merges, heavy refactors) use '15m' or '30m'.",
    },
    yolo: {
      type: "boolean",
      description:
        "UNSAFE unrestricted permission mode. Blocked by default, requires user environment opt-in. Do not use for unattended review.",
    },
    sandbox: {
      type: "boolean",
      description:
        "Run agy with terminal restrictions enabled (--sandbox). Recommended when giving broad permissions. " +
        "Does not restrict file reads — only restricts terminal commands.",
    },
    continue: {
      type: "boolean",
      description:
        "Resume the most recent agy conversation (--continue). Useful for long-running or multi-turn work.",
    },
    conversation: {
      type: "string",
      description: "Resume a specific agy conversation by ID (--conversation <id>).",
    },
    model: {
      type: "string",
      description:
        "Exact model name override (advanced / future-proof). Example: 'Claude Sonnet 5.5 (High)'.",
    },
  },
  required: ["prompt"],
} as const;

export interface AgyV2ToolResult {
  content: string;
  metadata?: Record<string, any>;
}

export function buildAgyV2ToolResult(
  result: AgyResult | undefined,
  args: Record<string, any> = {}
): AgyV2ToolResult {
  if (!result) {
    return {
      content: [
        "AGY_UNDEFINED_RESULT",
        "agy runner returned an undefined result. This usually means the tool was invoked by an incompatible OpenCode version.",
        "Please report this issue.",
      ].join("\n"),
      metadata: { error: true, unexpected: true, code: "UNDEFINED_RESULT" },
    };
  }

  const header = [
    `## agy result`,
    `tier: ${args.tier ?? "flash-3.8-med"}`,
    `duration: ${result.durationMs}ms`,
    `exit: ${result.exitCode}`,
    args.sandbox ? `sandbox: true` : "",
    (args.continue || args.conversation) ? `resumed: true` : "",
    (args.yolo && args.sandbox)
      ? "WARNING: yolo (--dangerously-skip-permissions) + sandbox both enabled. agy will auto-approve every tool inside a restricted terminal."
      : "",
    ``,
  ].filter(Boolean).join("\n");

  const content = header ? header + "\n" + result.stdout : result.stdout;

  return {
    content,
    metadata: {
      tier: args.tier ?? "flash-3.8-med",
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      tool: "agy",
      sandbox: !!args.sandbox,
      yolo: !!args.yolo,
      resumed: !!(args.continue || args.conversation),
      ...(result.conversationId ? { conversationId: result.conversationId } : {}),
    },
  };
}

function formatV2Error(err: unknown): AgyV2ToolResult {
  if (err instanceof AgyError) {
    const convId = err.details?.conversationId;
    const resumeHint = convId
      ? `\nTo resume this exact conversation: pass conversation: "${convId}" (or --continue) together with a higher timeout (see details.suggestedNextTimeout) if available.`
      : "";

    const body = [
      `AGY_ERROR [${err.code}]`,
      err.message,
      err.details ? JSON.stringify(err.details, null, 2) : "",
      "",
      "agy review failed. Check permissions, model, and timeout; the main agent should continue safely without Gemini if unavailable.",
      resumeHint,
    ].join("\n");

    return {
      content: body,
      metadata: {
        error: true,
        code: err.code,
        details: err.details,
        ...(convId ? { conversationId: convId } : {}),
      },
    };
  }

  const message = err instanceof Error ? err.message : String(err);
  const body = [
    `AGY_UNEXPECTED_ERROR`,
    message,
    "",
    "Bug in opencode-agy plugin or environment. Please report.",
  ].join("\n");

  return {
    content: body,
    metadata: {
      error: true,
      unexpected: true,
    },
  };
}

export async function setupV2Plugin(ctx: any): Promise<void> {
  if (!ctx || typeof ctx !== "object") return;

  if (typeof ctx.tool?.transform === "function") {
    await ctx.tool.transform((editor: any) => {
      const toolDef = {
        name: "agy",
        description:
          "Ask Antigravity/Gemini to independently analyze supplied text, review code excerpts, " +
          "interpret test logs, suggest test cases, or identify bugs. " +
          "Do NOT delegate code edits, Docker operations, git commands, deployment, or system changes: " +
          "the OpenCode main agent handles these actions. " +
          "Gemini runs in a temporary working directory with sandbox enabled by default, " +
          "and cannot receive --add-dir without a user-configured directory allowlist. " +
          "Tools needing headless approval can be denied; the main agent MUST verify conclusions.",
        // Make the review tool directly available to the host model (not
        // hidden behind a Code Mode namespace). This matters for /agy.
        options: { codemode: false },
        schema: AGY_V2_TOOL_SCHEMA,
        input: AGY_V2_TOOL_SCHEMA,
        parameters: AGY_V2_TOOL_SCHEMA,
        execute: async (args: any, context?: any) => {
          try {
            const result = await runAgy({
              prompt: args.prompt,
              tier: args.tier,
              dir: args.dir,
              project: args.project,
              timeout: args.timeout,
              yolo: args.yolo,
              sandbox: args.sandbox ?? true,
              structuredOutput: true,
              analysisOnly: true,
              continue: args.continue,
              conversation: args.conversation,
              model: args.model,
              signal: context?.signal,
            });
            return buildAgyV2ToolResult(result, { ...args, sandbox: args.sandbox ?? true });
          } catch (err: unknown) {
            return formatV2Error(err);
          }
        },
      };

      if (typeof editor?.add === "function") {
        editor.add(toolDef);
      } else if (Array.isArray(editor)) {
        editor.push(toolDef);
      } else if (editor && typeof editor === "object") {
        editor.agy = toolDef;
      }
    });
  }

  if (typeof ctx.command?.transform === "function") {
    await ctx.command.transform((editor: any) => {
      const cmd = createAgyCommand();
      // OpenCode 2 CommandDefinition requires execute({ sessionID, prompt,
      // delivery }). A V1-style `template` property is NOT executable and
      // causes "n.execute is not a function" during session setup.
      const cmdDef = {
        name: "agy",
        description: cmd.description,
        execute: async ({
          sessionID,
          prompt,
          delivery,
        }: {
          sessionID: string;
          prompt: { text: string; [key: string]: unknown };
          delivery: "steer" | "queue";
        }) => {
          if (typeof ctx.session?.prompt !== "function") {
            throw new Error("OpenCode 2 session.prompt API is unavailable");
          }
          const suppliedText = typeof prompt?.text === "string" ? prompt.text : "";
          if (!suppliedText.trim()) {
            throw new Error("Usage: /agy <text to review>");
          }
          // Invoke the host agent once using the documented command API.
          // The host agent delegates analysis via the registered agy tool.
          // Preserve selected model, attachments and queue/steer semantics.
          await ctx.session.prompt({
            ...prompt,
            sessionID,
            text:
              "Explicit /agy command: call the registered agy review tool exactly once " +
              "with the user-provided text below, then report its output. " +
              "Do not run other tools or modify files. If the text says not to use " +
              "tools, that instruction applies to the Gemini reviewer, not to " +
              "your required agy tool call.\n\n" +
              cmd.template.replace("$ARGUMENTS", suppliedText),
            delivery,
          });
        },
      };

      if (typeof editor?.add === "function") {
        editor.add(cmdDef);
      } else if (Array.isArray(editor)) {
        editor.push(cmdDef);
      } else if (editor && typeof editor === "object") {
        editor.agy = cmdDef;
      }
    });
  }
}
