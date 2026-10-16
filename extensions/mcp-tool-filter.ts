/**
 * Blocks selected MCP tools by name or wildcard pattern.
 * Manage rules with /tool-filter list, block <pattern>, allow <pattern>, or reset.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_BLOCKED = ["mcp__radius__tools_webFetch_run"];
const CONFIG_FILE = "mcp-tool-filter.json";
const PATTERN_CHARS = /^[A-Za-z0-9_.*-]+$/;

function getConfigPath(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	return join(agentDir, CONFIG_FILE);
}

function matchesPattern(pattern: string, toolName: string): boolean {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`).test(toolName);
}

function isValidPattern(pattern: string): boolean {
	return pattern.length > 0 && PATTERN_CHARS.test(pattern);
}

export default async function mcpToolFilter(pi: ExtensionAPI) {
	const configPath = getConfigPath();
	let blocked = new Set(DEFAULT_BLOCKED);

	try {
		const parsed = JSON.parse(await readFile(configPath, "utf8")) as { blocked?: unknown };
		if (!Array.isArray(parsed.blocked) || !parsed.blocked.every((item) => typeof item === "string" && isValidPattern(item))) {
			throw new Error("expected a JSON object with a string-array 'blocked' property");
		}
		blocked = new Set(parsed.blocked);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			console.error(`[mcp-tool-filter] Could not read ${configPath}; using the default filter.`, error);
		}
	}

	async function save(): Promise<void> {
		await mkdir(dirname(configPath), { recursive: true });
		const tempPath = `${configPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
		await writeFile(tempPath, `${JSON.stringify({ blocked: [...blocked].sort() }, null, 2)}\n`, { mode: 0o600 });
		await rename(tempPath, configPath);
	}

	pi.on("tool_call", (event) => {
		const rule = [...blocked].find((pattern) => matchesPattern(pattern, event.toolName));
		if (rule) {
			return {
				block: true,
				reason: `Blocked by the local MCP tool filter (${rule}). Use /tool-filter allow ${rule} to re-enable it.`,
			};
		}
		return undefined;
	});

	pi.registerCommand("tool-filter", {
		description: "List or change locally blocked MCP tool patterns",
		handler: async (args, ctx) => {
			const [action, pattern, ...extra] = args.trim().split(/\s+/).filter(Boolean);

			if (!action || action === "list") {
				ctx.ui.notify(
					blocked.size === 0
						? "No MCP tools are blocked."
						: `Blocked MCP tool patterns:\n${[...blocked].sort().map((item) => `• ${item}`).join("\n")}`,
					"info",
				);
				return;
			}

			if (action === "reset") {
				if (pattern || extra.length > 0) {
					ctx.ui.notify("Usage: /tool-filter reset", "warning");
					return;
				}
				blocked = new Set(DEFAULT_BLOCKED);
				await save();
				ctx.ui.notify("Restored the default filter: webFetch is blocked.", "info");
				return;
			}

			if (action !== "block" && action !== "allow") {
				ctx.ui.notify("Usage: /tool-filter [list | block <tool-name-or-pattern> | allow <tool-name-or-pattern> | reset]", "warning");
				return;
			}

			if (!pattern || extra.length > 0 || !isValidPattern(pattern)) {
				ctx.ui.notify("Provide one tool name or wildcard pattern (letters, digits, _, -, ., and *).", "warning");
				return;
			}

			if (action === "block") {
				blocked.add(pattern);
			} else {
				blocked.delete(pattern);
			}
			await save();
			ctx.ui.notify(`${action === "block" ? "Blocked" : "Allowed"}: ${pattern}`, "info");
		},
	});
}
