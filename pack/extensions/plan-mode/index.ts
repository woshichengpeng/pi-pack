/**
 * Plan Mode Extension
 *
 * Read-only exploration mode for safe code analysis.
 * When enabled, only read-only tools are available.
 *
 * Features:
 * - /plan command or Ctrl+Alt+P to toggle
 * - Bash restricted to allowlisted read-only commands
 * - Extracts numbered plan steps from "Plan:" sections
 * - [DONE:n] markers to complete steps during execution
 * - Progress tracking widget during execution
 * - Auto-saves plans to .pi/plans/ for cross-session reference
 * - /plans command to list saved plans
 * - Clean execution: execute plan in fresh context (plan only, no prior conversation)
 */

import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { extractTodoItems, isSafeCommand, markCompletedSteps, type TodoItem } from "./utils.js";

// Tools
const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire"];

// Type guard for assistant messages
function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

// Extract text content from an assistant message
function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

// --- Plan file persistence ---

function getPlansDir(cwd: string): string {
	return join(cwd, ".pi", "plans");
}

function generatePlanFilename(todoItems: TodoItem[]): string {
	const date = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	// Use first todo item as slug, or fallback to "plan"
	const firstStep = todoItems[0]?.text ?? "plan";
	const slug = firstStep
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return `${date}-${slug || "plan"}.md`;
}

function formatPlanMarkdown(todoItems: TodoItem[], fullText?: string): string {
	const lines: string[] = [];
	lines.push("# Plan");
	lines.push("");
	lines.push(`Created: ${new Date().toISOString()}`);
	lines.push("");

	lines.push("## Steps");
	lines.push("");
	for (const item of todoItems) {
		const check = item.completed ? "x" : " ";
		lines.push(`- [${check}] ${item.step}. ${item.text}`);
	}
	lines.push("");

	if (fullText) {
		lines.push("## Full Plan Output");
		lines.push("");
		lines.push(fullText);
		lines.push("");
	}

	return lines.join("\n");
}

function savePlan(cwd: string, todoItems: TodoItem[], fullText?: string): string | null {
	if (todoItems.length === 0) return null;
	try {
		const plansDir = getPlansDir(cwd);
		mkdirSync(plansDir, { recursive: true });
		const filename = generatePlanFilename(todoItems);
		const filepath = join(plansDir, filename);
		const content = formatPlanMarkdown(todoItems, fullText);
		writeFileSync(filepath, content);
		return filepath;
	} catch (err) {
		// Non-fatal: log but don't break the extension
		console.error(`[plan-mode] Failed to save plan: ${err}`);
		return null;
	}
}

function updatePlanFile(filepath: string, todoItems: TodoItem[]): void {
	try {
		if (!existsSync(filepath)) return;
		const content = readFileSync(filepath, "utf-8");
		// Update checkbox states in the Steps section
		const lines = content.split("\n");
		const updatedLines = lines.map((line) => {
			const stepMatch = line.match(/^- \[[ x]\] (\d+)\. (.+)$/);
			if (stepMatch) {
				const step = parseInt(stepMatch[1], 10);
				const item = todoItems.find((t) => t.step === step);
				if (item) {
					const check = item.completed ? "x" : " ";
					return `- [${check}] ${item.step}. ${item.text}`;
				}
			}
			return line;
		});
		writeFileSync(filepath, updatedLines.join("\n"));
	} catch {
		// Non-fatal
	}
}

function listSavedPlans(cwd: string): Array<{ filename: string; filepath: string }> {
	const plansDir = getPlansDir(cwd);
	if (!existsSync(plansDir)) return [];
	try {
		return readdirSync(plansDir)
			.filter((f) => f.endsWith(".md"))
			.sort()
			.reverse() // Most recent first
			.map((f) => ({ filename: f, filepath: join(plansDir, f) }));
	} catch {
		return [];
	}
}

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let executionMode = false;
	let cleanExecution = false; // When true, strip all prior context — LLM sees only the plan
	let todoItems: TodoItem[] = [];
	let currentPlanFile: string | null = null; // Track the active plan file for updates
	let fullPlanText: string | undefined; // Full plan output for clean execution context

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration)",
		type: "boolean",
		default: false,
	});

	function updateStatus(ctx: ExtensionContext): void {
		// Footer status
		if (executionMode && todoItems.length > 0) {
			const completed = todoItems.filter((t) => t.completed).length;
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", `📋 ${completed}/${todoItems.length}`));
		} else if (planModeEnabled) {
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "⏸ plan"));
		} else {
			ctx.ui.setStatus("plan-mode", undefined);
		}

		// Widget showing todo list
		if (executionMode && todoItems.length > 0) {
			const lines = todoItems.map((item) => {
				if (item.completed) {
					return (
						ctx.ui.theme.fg("success", "☑ ") + ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text))
					);
				}
				return `${ctx.ui.theme.fg("muted", "☐ ")}${item.text}`;
			});
			ctx.ui.setWidget("plan-todos", lines);
		} else {
			ctx.ui.setWidget("plan-todos", undefined);
		}
	}

	function togglePlanMode(ctx: ExtensionContext): void {
		planModeEnabled = !planModeEnabled;
		executionMode = false;
		cleanExecution = false;
		todoItems = [];
		currentPlanFile = null;
		fullPlanText = undefined;

		if (planModeEnabled) {
			pi.setActiveTools(PLAN_MODE_TOOLS);
			ctx.ui.notify(`Plan mode enabled. Tools: ${PLAN_MODE_TOOLS.join(", ")}`);
		} else {
			pi.setActiveTools(pi.getAllTools().map(t => t.name));
			ctx.ui.notify("Plan mode disabled. Full access restored.");
		}
		updateStatus(ctx);
	}

	function persistState(): void {
		pi.appendEntry("plan-mode", {
			enabled: planModeEnabled,
			todos: todoItems,
			executing: executionMode,
			cleanExec: cleanExecution,
			planFile: currentPlanFile,
			planText: fullPlanText,
		});
	}

	pi.registerCommand("plan", {
		description: "Toggle plan mode (read-only exploration)",
		handler: async (_args, ctx) => togglePlanMode(ctx),
	});

	pi.registerCommand("todos", {
		description: "Show current plan todo list",
		handler: async (_args, ctx) => {
			if (todoItems.length === 0) {
				ctx.ui.notify("No todos. Create a plan first with /plan", "info");
				return;
			}
			const list = todoItems.map((item, i) => `${i + 1}. ${item.completed ? "✓" : "○"} ${item.text}`).join("\n");
			ctx.ui.notify(`Plan Progress:\n${list}`, "info");
		},
	});

	pi.registerCommand("plans", {
		description: "List saved plans",
		handler: async (_args, ctx) => {
			const plans = listSavedPlans(ctx.cwd);
			if (plans.length === 0) {
				ctx.ui.notify("No saved plans. Plans are auto-saved to .pi/plans/ when created in plan mode.", "info");
				return;
			}

			const choices = plans.map((p) => p.filename);
			const selected = await ctx.ui.select("Saved plans (select to view):", choices);
			if (selected) {
				const plan = plans.find((p) => p.filename === selected);
				if (plan) {
					try {
						const content = readFileSync(plan.filepath, "utf-8");
						ctx.ui.notify(`📋 ${plan.filename}\n\n${content}`, "info");
					} catch {
						ctx.ui.notify(`Failed to read plan: ${plan.filepath}`, "error");
					}
				}
			}
		},
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => togglePlanMode(ctx),
	});

	// Block destructive bash commands in plan mode
	pi.on("tool_call", async (event) => {
		if (!planModeEnabled || event.toolName !== "bash") return;

		const command = event.input.command as string;
		if (!isSafeCommand(command)) {
			return {
				block: true,
				reason: `Plan mode: command blocked (not allowlisted). Use /plan to disable plan mode first.\nCommand: ${command}`,
			};
		}
	});

	// Filter context messages based on mode
	pi.on("context", async (event) => {
		// Clean execution: strip all messages from BEFORE execution started.
		// Keep the plan-execution-context, plan-mode-execute, and everything after.
		if (cleanExecution && executionMode) {
			let foundExecuteMarker = false;
			return {
				messages: event.messages.filter((m) => {
					const msg = m as AgentMessage & { customType?: string };
					// Always keep the plan execution context (injected by before_agent_start)
					if (msg.customType === "plan-execution-context") return true;
					// The execute message marks the boundary — keep it and everything after
					if (msg.customType === "plan-mode-execute") {
						foundExecuteMarker = true;
						return true;
					}
					// Keep all messages after the execute marker (execution responses, tool calls, etc.)
					if (foundExecuteMarker) return true;
					// Strip everything before execution
					return false;
				}),
			};
		}

		// Normal: filter out stale plan mode context when not in plan mode
		if (planModeEnabled) return;

		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				if (msg.customType === "plan-mode-context") return false;
				if (msg.role !== "user") return true;

				const content = msg.content;
				if (typeof content === "string") {
					return !content.includes("[PLAN MODE ACTIVE]");
				}
				if (Array.isArray(content)) {
					return !content.some(
						(c) => c.type === "text" && (c as TextContent).text?.includes("[PLAN MODE ACTIVE]"),
					);
				}
				return true;
			}),
		};
	});

	// Inject plan/execution context before agent starts
	pi.on("before_agent_start", async () => {
		if (planModeEnabled) {
			return {
				message: {
					customType: "plan-mode-context",
					content: `[PLAN MODE ACTIVE]
You are in plan mode - a read-only exploration mode for safe code analysis.

Restrictions:
- You can only use: read, bash, grep, find, ls, questionnaire
- You CANNOT use: edit, write (file modifications are disabled)
- Bash is restricted to an allowlist of read-only commands

Ask clarifying questions using the questionnaire tool.
Use brave-search skill via bash for web research.

Create a detailed numbered plan under a "Plan:" header:

Plan:
1. First step description
2. Second step description
...

Do NOT attempt to make changes - just describe what you would do.`,
					display: false,
				},
			};
		}

		if (executionMode && todoItems.length > 0) {
			const remaining = todoItems.filter((t) => !t.completed);
			const todoList = remaining.map((t) => `${t.step}. ${t.text}`).join("\n");
			const allSteps = todoItems.map((t) => `${t.step}. ${t.text}`).join("\n");

			// In clean execution, include the full plan since prior context is stripped
			const planContext = cleanExecution
				? `[EXECUTING PLAN - Clean context, full tool access enabled]

Full plan:
${allSteps}

Remaining steps:
${todoList}

${fullPlanText ? `Original plan details:\n${fullPlanText}\n\n` : ""}Execute each step in order.
After completing a step, include a [DONE:n] tag in your response.`
				: `[EXECUTING PLAN - Full tool access enabled]

Remaining steps:
${todoList}

Execute each step in order.
After completing a step, include a [DONE:n] tag in your response.`;
			return {
				message: {
					customType: "plan-execution-context",
					content: planContext,
					display: false,
				},
			};
		}
	});

	// Track progress after each turn
	pi.on("turn_end", async (event, ctx) => {
		if (!executionMode || todoItems.length === 0) return;
		if (!isAssistantMessage(event.message)) return;

		const text = getTextContent(event.message);
		if (markCompletedSteps(text, todoItems) > 0) {
			updateStatus(ctx);
			// Update the saved plan file with new completion states
			if (currentPlanFile) {
				updatePlanFile(currentPlanFile, todoItems);
			}
		}
		persistState();
	});

	// Handle plan completion and plan mode UI
	pi.on("agent_end", async (event, ctx) => {
		// Check if execution is complete
		if (executionMode && todoItems.length > 0) {
			if (todoItems.every((t) => t.completed)) {
				const completedList = todoItems.map((t) => `~~${t.text}~~`).join("\n");
				pi.sendMessage(
					{ customType: "plan-complete", content: `**Plan Complete!** ✓\n\n${completedList}`, display: true },
					{ triggerTurn: false },
				);
				// Update plan file one last time with all items completed
				if (currentPlanFile) {
					updatePlanFile(currentPlanFile, todoItems);
				}
				executionMode = false;
				cleanExecution = false;
				todoItems = [];
				currentPlanFile = null;
				fullPlanText = undefined;
				pi.setActiveTools(pi.getAllTools().map(t => t.name));
				updateStatus(ctx);
				persistState(); // Save cleared state so resume doesn't restore old execution mode
			}
			return;
		}

		if (!planModeEnabled || !ctx.hasUI) return;

		// Extract todos from last assistant message
		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		if (lastAssistant) {
			fullPlanText = getTextContent(lastAssistant);
			const extracted = extractTodoItems(fullPlanText);
			if (extracted.length > 0) {
				todoItems = extracted;
			}
		}

		// Auto-save plan to .pi/plans/
		if (todoItems.length > 0) {
			const savedPath = savePlan(ctx.cwd, todoItems, fullPlanText);
			if (savedPath) {
				currentPlanFile = savedPath;
				const relPath = savedPath.startsWith(ctx.cwd)
					? savedPath.slice(ctx.cwd.length + 1)
					: savedPath;
				ctx.ui.notify(`Plan saved to ${relPath}`, "info");
			}
		}

		// Show plan steps and prompt for next action
		if (todoItems.length > 0) {
			const todoListText = todoItems.map((t, i) => `${i + 1}. ☐ ${t.text}`).join("\n");
			pi.sendMessage(
				{
					customType: "plan-todo-list",
					content: `**Plan Steps (${todoItems.length}):**\n\n${todoListText}`,
					display: true,
				},
				{ triggerTurn: false },
			);
		}

		const choice = await ctx.ui.select("Plan mode - what next?", [
			todoItems.length > 0 ? "Execute the plan (track progress)" : "Execute the plan",
			todoItems.length > 0 ? "Execute in clean context (plan only)" : undefined,
			"Stay in plan mode",
			"Refine the plan",
		].filter((c): c is string => c !== undefined));

		if (choice?.startsWith("Execute in clean")) {
			planModeEnabled = false;
			executionMode = true;
			cleanExecution = true;
			pi.setActiveTools(pi.getAllTools().map(t => t.name));
			updateStatus(ctx);

			const execMessage = `Execute the plan. Start with: ${todoItems[0].text}`;
			pi.sendMessage(
				{ customType: "plan-mode-execute", content: execMessage, display: true },
				{ triggerTurn: true },
			);
		} else if (choice?.startsWith("Execute")) {
			planModeEnabled = false;
			executionMode = todoItems.length > 0;
			pi.setActiveTools(pi.getAllTools().map(t => t.name));
			updateStatus(ctx);

			const execMessage =
				todoItems.length > 0
					? `Execute the plan. Start with: ${todoItems[0].text}`
					: "Execute the plan you just created.";
			pi.sendMessage(
				{ customType: "plan-mode-execute", content: execMessage, display: true },
				{ triggerTurn: true },
			);
		} else if (choice === "Refine the plan") {
			const refinement = await ctx.ui.editor("Refine the plan:", "");
			if (refinement?.trim()) {
				pi.sendUserMessage(refinement.trim());
			}
		}
	});

	// Restore state on session start/resume
	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("plan") === true) {
			planModeEnabled = true;
		}

		const entries = ctx.sessionManager.getEntries();

		// Restore persisted state
		const planModeEntry = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plan-mode")
			.pop() as { data?: { enabled: boolean; todos?: TodoItem[]; executing?: boolean; cleanExec?: boolean; planFile?: string; planText?: string } } | undefined;

		if (planModeEntry?.data) {
			planModeEnabled = planModeEntry.data.enabled ?? planModeEnabled;
			todoItems = planModeEntry.data.todos ?? todoItems;
			executionMode = planModeEntry.data.executing ?? executionMode;
			cleanExecution = planModeEntry.data.cleanExec ?? false;
			currentPlanFile = planModeEntry.data.planFile ?? null;
			fullPlanText = planModeEntry.data.planText ?? undefined;
		}

		// On resume: re-scan messages to rebuild completion state
		// Only scan messages AFTER the last "plan-mode-execute" to avoid picking up [DONE:n] from previous plans
		const isResume = planModeEntry !== undefined;
		if (isResume && executionMode && todoItems.length > 0) {
			// Find the index of the last plan-mode-execute entry (marks when current execution started)
			let executeIndex = -1;
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i] as { type: string; customType?: string };
				if (entry.customType === "plan-mode-execute") {
					executeIndex = i;
					break;
				}
			}

			// Only scan messages after the execute marker
			const messages: AssistantMessage[] = [];
			for (let i = executeIndex + 1; i < entries.length; i++) {
				const entry = entries[i];
				if (entry.type === "message" && "message" in entry && isAssistantMessage(entry.message as AgentMessage)) {
					messages.push(entry.message as AssistantMessage);
				}
			}
			const allText = messages.map(getTextContent).join("\n");
			markCompletedSteps(allText, todoItems);

			// Sync file with restored completion state
			if (currentPlanFile) {
				updatePlanFile(currentPlanFile, todoItems);
			}
		}

		if (planModeEnabled) {
			pi.setActiveTools(PLAN_MODE_TOOLS);
		}
		updateStatus(ctx);
	});
}
