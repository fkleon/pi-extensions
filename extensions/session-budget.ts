/**
 * Pauses a Pi session when its recorded model/tool cost reaches a USD limit.
 * Configure with /budget set <amount>, inspect with /budget status, or disable with /budget off.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CONFIG_FILE = "session-budget.json";
const COMMAND = "/budget";

type BudgetConfig = { limitUsd: number | null };
type UsageMessage = { role: string; usage?: Usage };

function getConfigPath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(agentDir, CONFIG_FILE);
}

function isValidConfig(value: unknown): value is BudgetConfig {
  if (typeof value !== "object" || value === null || !("limitUsd" in value)) return false;
  const limit = (value as { limitUsd: unknown }).limitUsd;
  return limit === null || (typeof limit === "number" && Number.isFinite(limit) && limit >= 0);
}

function addMessageCost(message: UsageMessage): number {
  return (message.role === "assistant" || message.role === "toolResult") && message.usage
    ? message.usage.cost.total
    : 0;
}

function getSessionCost(ctx: ExtensionContext, extraMessages: UsageMessage[] = []): number {
  const entries = ctx.sessionManager.getEntries();
  const persistedMessages = new Set<UsageMessage>();
  let total = 0;

  for (const entry of entries) {
    if (entry.type === "message") {
      persistedMessages.add(entry.message);
      total += addMessageCost(entry.message);
    } else if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") {
      total += entry.usage?.cost.total ?? 0;
    }
  }

  // Lifecycle events can fire before the just-completed message is visible in getEntries().
  for (const message of extraMessages) {
    if (!persistedMessages.has(message)) total += addMessageCost(message);
  }

  return total;
}

function formatUsd(amount: number): string {
  return `$${amount.toFixed(4)}`;
}

export default async function sessionBudget(pi: ExtensionAPI) {
  const configPath = getConfigPath();
  let limitUsd: number | null = null;
  let paused = false;

  try {
    const parsed: unknown = JSON.parse(await readFile(configPath, "utf8"));
    if (!isValidConfig(parsed)) throw new Error("expected { limitUsd: non-negative number | null }");
    limitUsd = parsed.limitUsd;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`[session-budget] Could not read ${configPath}; budget limiting is disabled.`, error);
    }
  }

  async function saveConfig(nextLimit: number | null): Promise<void> {
    await mkdir(dirname(configPath), { recursive: true });
    const tempPath = `${configPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tempPath, `${JSON.stringify({ limitUsd: nextLimit }, null, 2)}\n`, { mode: 0o600 });
    await rename(tempPath, configPath);
  }

  function refresh(ctx: ExtensionContext, extraMessages: UsageMessage[] = []): { cost: number; overLimit: boolean } {
    const cost = getSessionCost(ctx, extraMessages);
    const overLimit = limitUsd !== null && cost >= limitUsd;
    const newlyPaused = overLimit && !paused;
    paused = overLimit;

    if (newlyPaused && ctx.hasUI) {
      const limitText = limitUsd === null ? "disabled" : formatUsd(limitUsd);
      ctx.ui.notify(
        `Session budget reached (${formatUsd(cost)} / ${limitText}). Pi is pausing; use /budget set <higher-limit> or /budget off to continue.`,
        "warning",
      );
    }

    return { cost, overLimit };
  }

  function isBudgetCommand(text: string): boolean {
    const trimmed = text.trim();
    return trimmed === COMMAND || trimmed.startsWith(`${COMMAND} `);
  }

  pi.on("session_start", (_event, ctx) => {
    paused = false;
    refresh(ctx);
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const { overLimit } = refresh(ctx, [event.message]);
    if (overLimit) ctx.abort();
  });

  pi.on("turn_end", (event, ctx) => {
    const { overLimit } = refresh(ctx, [event.message, ...event.toolResults]);
    if (overLimit) ctx.abort();
  });

  pi.on("agent_before_settle", (_event, ctx) => {
    const { overLimit } = refresh(ctx);
    if (overLimit) ctx.abort();
  });

  pi.on("before_agent_start", (_event, ctx) => {
    const { overLimit } = refresh(ctx);
    if (overLimit) ctx.abort();
  });

  pi.on("input", (event, ctx) => {
    if (isBudgetCommand(event.text)) return { action: "continue" };

    const { cost, overLimit } = refresh(ctx);
    if (!overLimit) return { action: "continue" };

    if (ctx.hasUI) {
      const limitText = limitUsd === null ? "disabled" : formatUsd(limitUsd);
      ctx.ui.notify(
        `Prompt held: session budget is ${formatUsd(cost)} / ${limitText}. Raise the limit with /budget set <amount> or disable it with /budget off.`,
        "warning",
      );
    }
    return { action: "handled" };
  });

  pi.registerCommand("budget", {
    description: "Check or set the session USD budget limit",
    handler: async (args, ctx) => {
      const [action, value, ...extra] = args.trim().split(/\s+/).filter(Boolean);

      if (!action || action === "status") {
        if (value || extra.length > 0) {
          ctx.ui.notify("Usage: /budget [status | set <USD> | off]", "warning");
          return;
        }
        const { cost, overLimit } = refresh(ctx);
        const limitText = limitUsd === null ? "no limit" : formatUsd(limitUsd);
        ctx.ui.notify(
          `Session cost: ${formatUsd(cost)}; limit: ${limitText}; state: ${overLimit ? "paused" : "active"}.`,
          "info",
        );
        return;
      }

      if (action === "off") {
        if (value || extra.length > 0) {
          ctx.ui.notify("Usage: /budget off", "warning");
          return;
        }
        await saveConfig(null);
        limitUsd = null;
        paused = false;
        ctx.ui.notify("Session budget limit disabled.", "info");
        return;
      }

      if (action !== "set" || !value || extra.length > 0) {
        ctx.ui.notify("Usage: /budget [status | set <USD> | off]", "warning");
        return;
      }

      const nextLimit = Number(value);
      if (!Number.isFinite(nextLimit) || nextLimit < 0) {
        ctx.ui.notify("Budget must be a non-negative USD amount, for example /budget set 5.00.", "warning");
        return;
      }

      await saveConfig(nextLimit);
      limitUsd = nextLimit;
      paused = false;
      const { overLimit } = refresh(ctx);
      if (overLimit) {
        ctx.abort();
      } else {
        ctx.ui.notify(`Session budget limit set to ${formatUsd(nextLimit)}.`, "info");
      }
    },
  });
}
