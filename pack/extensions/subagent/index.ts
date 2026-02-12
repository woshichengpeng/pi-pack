/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import { StringEnum } from "@mariozechner/pi-ai";
import { type ExtensionAPI, type ExtensionContext, getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.js";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PROGRESS_PREVIEW_LIMIT = 120;
const PROGRESS_MAX_ITEMS = 6;
const JOB_WIDGET_REFRESH_MS = 2000;
const JOB_WIDGET_MAX_ITEMS = 4;
const JOB_WIDGET_PREVIEW_LIMIT = 80;
const COMPLETED_JOB_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
const COMPLETED_JOB_MAX_COUNT = 50;
const SESSION_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours
const SESSION_MAX_COUNT = 50;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	completed: boolean;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	sessionId?: string;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

function formatToolCallPlain(toolName: string, args: Record<string, unknown>): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return `$ ${preview}`;
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = `read ${filePath}`;
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += `:${startLine}${endLine ? `-${endLine}` : ""}`;
			}
			return text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			return `write ${filePath}${lines > 1 ? ` (${lines} lines)` : ""}`;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return `edit ${shortenPath(rawPath)}`;
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return `ls ${shortenPath(rawPath)}`;
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return `find ${pattern} in ${shortenPath(rawPath)}`;
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return `grep /${pattern}/ in ${shortenPath(rawPath)}`;
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return `${toolName} ${preview}`;
		}
	}
}

function formatPreviewText(text: string, maxLength = PROGRESS_PREVIEW_LIMIT): string {
	const cleaned = text.replace(/\s+/g, " ").trim();
	if (!cleaned) return "(no output yet)";
	return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}...` : cleaned;
}

function formatDisplayItemPlain(item: DisplayItem): string {
	if (item.type === "text") return formatPreviewText(item.text);
	return `→ ${formatToolCallPlain(item.name, item.args)}`;
}

function summarizeProgress(details: SubagentDetails, isRunning: boolean): string {
	if (!details.results.length) return "(no output yet)";

	const getPreview = (result: SingleResult) => {
		const items = getDisplayItems(result.messages);
		if (!items.length) return "(no output yet)";
		return formatDisplayItemPlain(items[items.length - 1]);
	};

	const statusFor = (result: SingleResult): string => {
		if (!result.completed) return "running";
		return result.exitCode === 0 ? "done" : "failed";
	};

	if (details.mode === "single" && details.results.length === 1) {
		const r = details.results[0];
		const status = isRunning ? "running" : statusFor(r);
		return `${r.agent} (${status}) ${getPreview(r)}`;
	}

	if (details.mode === "chain") {
		const total = details.results.length;
		const lines: string[] = [];
		const header = isRunning
			? `Chain running: ${total} step${total > 1 ? "s" : ""}`
			: `Chain completed: ${total} step${total > 1 ? "s" : ""}`;
		lines.push(header);

		const startIndex = Math.max(0, total - PROGRESS_MAX_ITEMS);
		if (startIndex > 0) lines.push(`... ${startIndex} earlier step${startIndex > 1 ? "s" : ""} hidden`);

		for (let i = startIndex; i < total; i++) {
			const r = details.results[i];
			const stepLabel = r.step ?? i + 1;
			const status = isRunning && i === total - 1 ? "running" : statusFor(r);
			lines.push(`${stepLabel}. ${r.agent} (${status}) ${getPreview(r)}`);
		}
		return lines.join("\n");
	}

	if (details.mode === "parallel") {
		const total = details.results.length;
		const running = details.results.filter((r) => !r.completed).length;
		const failed = details.results.filter((r) => r.completed && r.exitCode > 0).length;
		const succeeded = details.results.filter((r) => r.completed && r.exitCode === 0).length;

		const header = isRunning
			? `Parallel running: ${succeeded + failed}/${total} done, ${running} running`
			: `Parallel completed: ${succeeded}/${total} succeeded`;
		const lines: string[] = [header];

		const limit = Math.min(total, PROGRESS_MAX_ITEMS);
		for (let i = 0; i < limit; i++) {
			const r = details.results[i];
			const status = statusFor(r);
			lines.push(`${i + 1}. ${r.agent} (${status}) ${getPreview(r)}`);
		}
		if (total > limit) lines.push(`... +${total - limit} more`);
		return lines.join("\n");
	}

	return "(no output yet)";
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

function writePromptToTempFile(agentName: string, prompt: string): { dir: string; filePath: string } {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	fs.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	return { dir: tmpDir, filePath };
}

// --- Session management for subagent resume ---

interface SubagentSession {
	id: string;
	agent: string;
	sessionFilePath: string;
	promptTmpDir: string | null; // keep prompt file alive for continued sessions
	createdAt: number;
	lastUsedAt: number;
	inUse: boolean;
}

let sessionCounter = 0;
const subagentSessions = new Map<string, SubagentSession>();

function generateSessionId(): string {
	return `sa-${process.pid}-${++sessionCounter}`;
}

function getSessionDir(): string {
	const dir = path.join(os.tmpdir(), "pi-subagent-sessions");
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}

function createSession(agentName: string, promptTmpDir: string | null): SubagentSession {
	const id = generateSessionId();
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const sessionFilePath = path.join(getSessionDir(), `${id}-${safeName}.jsonl`);
	const session: SubagentSession = {
		id,
		agent: agentName,
		sessionFilePath,
		promptTmpDir,
		createdAt: Date.now(),
		lastUsedAt: Date.now(),
		inUse: false,
	};
	subagentSessions.set(id, session);
	evictOldSessions();
	return session;
}

function evictOldSessions(): void {
	const now = Date.now();
	const toDelete: string[] = [];

	for (const [id, session] of subagentSessions) {
		if (session.inUse) continue;
		const age = now - session.lastUsedAt;
		if (age > SESSION_MAX_AGE_MS) toDelete.push(id);
	}

	for (const id of toDelete) cleanupSession(id);

	// If still over limit, remove oldest (skip in-use sessions)
	if (subagentSessions.size > SESSION_MAX_COUNT) {
		const sorted = Array.from(subagentSessions.entries())
			.filter(([, s]) => !s.inUse)
			.sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
		while (subagentSessions.size > SESSION_MAX_COUNT && sorted.length > 0) {
			const [id] = sorted.shift()!;
			cleanupSession(id);
		}
	}
}

function cleanupSession(id: string): void {
	const session = subagentSessions.get(id);
	if (!session) return;
	try {
		fs.rmSync(session.sessionFilePath, { force: true });
	} catch { /* ignore */ }
	if (session.promptTmpDir) {
		try {
			fs.rmSync(session.promptTmpDir, { recursive: true, force: true });
		} catch { /* ignore */ }
	}
	subagentSessions.delete(id);
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	sessionId?: string,
	enableSession: boolean = true,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			completed: true,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	// Resolve or create session
	let existingSession: SubagentSession | undefined;
	if (sessionId) {
		existingSession = subagentSessions.get(sessionId);
		if (!existingSession) {
			return {
				agent: agentName,
				agentSource: agent.source,
				task,
				exitCode: 1,
				completed: true,
				messages: [],
				stderr: `Session not found: "${sessionId}". It may have expired. Start a new session without sessionId.`,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				step,
			};
		}
		if (existingSession.agent !== agentName) {
			return {
				agent: agentName,
				agentSource: agent.source,
				task,
				exitCode: 1,
				completed: true,
				messages: [],
				stderr: `Session "${sessionId}" belongs to agent "${existingSession.agent}", not "${agentName}".`,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				step,
			};
		}
		if (existingSession.inUse) {
			return {
				agent: agentName,
				agentSource: agent.source,
				task,
				exitCode: 1,
				completed: true,
				messages: [],
				stderr: `Session "${sessionId}" is currently in use by another invocation. Wait for it to finish.`,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				step,
			};
		}
		if (!fs.existsSync(existingSession.sessionFilePath)) {
			cleanupSession(sessionId);
			return {
				agent: agentName,
				agentSource: agent.source,
				task,
				exitCode: 1,
				completed: true,
				messages: [],
				stderr: `Session file for "${sessionId}" no longer exists on disk. Start a new session without sessionId.`,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				step,
			};
		}
		existingSession.lastUsedAt = Date.now();
	}

	const args: string[] = ["--mode", "json", "-p"];
	if (agent.model) args.push("--model", agent.model);
	if (agent.thinkingLevel) args.push("--thinking", agent.thinkingLevel);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;
	let session: SubagentSession | undefined;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		completed: false,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: agent.model,
		step,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (existingSession) {
			// Resume existing session
			args.push("--continue", "--session", existingSession.sessionFilePath);
			// System prompt is already baked into the session, but we need the prompt file
			// to still exist if it was used. The session object keeps its promptTmpDir alive.
			session = existingSession;
		} else if (enableSession) {
			// New invocation: create a session for potential future resume
			if (agent.systemPrompt.trim()) {
				const tmp = writePromptToTempFile(agent.name, agent.systemPrompt);
				tmpPromptDir = tmp.dir;
				tmpPromptPath = tmp.filePath;
				args.push("--append-system-prompt", tmpPromptPath);
			}
			session = createSession(agentName, tmpPromptDir);
			// Transfer ownership of tmpPromptDir to the session so it persists
			tmpPromptDir = null;
			args.push("--session", session.sessionFilePath);
		} else {
			// One-shot invocation (chain/parallel steps): no session persistence
			if (agent.systemPrompt.trim()) {
				const tmp = writePromptToTempFile(agent.name, agent.systemPrompt);
				tmpPromptDir = tmp.dir;
				tmpPromptPath = tmp.filePath;
				args.push("--append-system-prompt", tmpPromptPath);
			}
			args.push("--no-session");
		}

		if (session) session.inUse = true;

		args.push(`Task: ${task}`);
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const proc = spawn("pi", args, { cwd: cwd ?? defaultCwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		currentResult.completed = true;
		if (wasAborted) {
			// Clean up session on abort — the session file may be corrupted
			if (session) cleanupSession(session.id);
			currentResult.sessionId = undefined;
			throw new Error("Subagent was aborted");
		}
		currentResult.sessionId = session?.id;
		return currentResult;
	} finally {
		if (session) session.inUse = false;
		if (tmpPromptDir)
			try {
				fs.rmSync(tmpPromptDir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
	}
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	sessionId: Type.Optional(
		Type.String({
			description:
				"Resume a previous subagent session by its ID (single mode only). The agent will continue with full conversation history.",
		}),
	),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	background: Type.Optional(
		Type.Boolean({
			description:
				"Run in background. Returns immediately with a job ID. A notification will appear when the job finishes.",
			default: false,
		}),
	),
});

// --- Background job management ---

type JobStatus = "running" | "completed" | "failed";

interface BackgroundJob {
	id: string;
	status: JobStatus;
	agent: string;
	task: string;
	mode: "single" | "parallel" | "chain";
	startedAt: number;
	finishedAt?: number;
	lastUpdateAt?: number;
	lastSummary?: string;
	abortController?: AbortController;
	result?: {
		content: Array<{ type: "text"; text: string }>;
		details: SubagentDetails;
		isError?: boolean;
	};
}

let jobCounter = 0;
const backgroundJobs = new Map<string, BackgroundJob>();

function generateJobId(): string {
	return `job-${++jobCounter}`;
}

function evictOldJobs(): void {
	const now = Date.now();
	const completed = Array.from(backgroundJobs.entries())
		.filter(([, j]) => j.status !== "running")
		.sort((a, b) => (a[1].finishedAt ?? 0) - (b[1].finishedAt ?? 0));

	for (const [id, job] of completed) {
		const age = now - (job.finishedAt ?? job.startedAt);
		if (age > COMPLETED_JOB_MAX_AGE_MS) backgroundJobs.delete(id);
	}

	// If still over limit, remove oldest
	const remaining = Array.from(backgroundJobs.entries())
		.filter(([, j]) => j.status !== "running")
		.sort((a, b) => (a[1].finishedAt ?? 0) - (b[1].finishedAt ?? 0));
	while (remaining.length > COMPLETED_JOB_MAX_COUNT) {
		const [id] = remaining.shift()!;
		backgroundJobs.delete(id);
	}
}

function getRunningJobs(): BackgroundJob[] {
	return Array.from(backgroundJobs.values()).filter((job) => job.status === "running");
}

function formatJobSummary(job: BackgroundJob): string {
	const elapsed = ((job.finishedAt ?? Date.now()) - job.startedAt) / 1000;
	const icon = job.status === "running" ? "⏳" : job.status === "completed" ? "✓" : "✗";
	return `${icon} ${job.id} [${job.mode}] ${job.agent}: ${job.task.slice(0, 60)}${job.task.length > 60 ? "..." : ""} (${job.status}, ${elapsed.toFixed(1)}s)`;
}

function formatJobWidgetLine(job: BackgroundJob): string {
	const summary = job.lastSummary
		? formatPreviewText(job.lastSummary, JOB_WIDGET_PREVIEW_LIMIT)
		: "(no output yet)";
	const elapsed = ((Date.now() - job.startedAt) / 1000).toFixed(0);
	return `• ${job.id} ${job.agent} (${elapsed}s): ${summary}`;
}

// Extracted foreground execution logic so it can be reused by background mode
async function runForegroundExecution(
	params: any,
	cwd: string,
	agents: AgentConfig[],
	agentScope: AgentScope,
	discovery: { projectAgentsDir: string | null },
	makeDetails: (mode: "single" | "parallel" | "chain") => (results: SingleResult[]) => SubagentDetails,
	signal?: AbortSignal,
	onUpdate?: OnUpdateCallback,
	sessionId?: string,
): Promise<{ content: Array<{ type: string; text: string }>; details: SubagentDetails; isError?: boolean }> {
	if (params.chain && params.chain.length > 0) {
		const results: SingleResult[] = [];
		let previousOutput = "";

		for (let i = 0; i < params.chain.length; i++) {
			const step = params.chain[i];
			const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

			const chainUpdate: OnUpdateCallback | undefined = onUpdate
				? (partial) => {
						const currentResult = partial.details?.results[0];
						if (currentResult) {
							const allResults = [...results, currentResult];
							onUpdate({
								content: partial.content,
								details: makeDetails("chain")(allResults),
							});
						}
					}
				: undefined;

			const result = await runSingleAgent(
				cwd, agents, step.agent, taskWithContext, step.cwd, i + 1,
				signal, chainUpdate, makeDetails("chain"),
				undefined, false,
			);
			results.push(result);

			const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
			if (isError) {
				const errorMsg = result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
				return {
					content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
					details: makeDetails("chain")(results),
					isError: true,
				};
			}
			previousOutput = getFinalOutput(result.messages);
		}
		return {
			content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
			details: makeDetails("chain")(results),
		};
	}

	if (params.tasks && params.tasks.length > 0) {
		if (params.tasks.length > MAX_PARALLEL_TASKS)
			return {
				content: [{ type: "text", text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.` }],
				details: makeDetails("parallel")([]),
			};

		const allResults: SingleResult[] = new Array(params.tasks.length);
		for (let i = 0; i < params.tasks.length; i++) {
			allResults[i] = {
				agent: params.tasks[i].agent, agentSource: "unknown", task: params.tasks[i].task,
				exitCode: -1,
				completed: false,
				messages: [],
				stderr: "",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			};
		}

		const emitParallelUpdate = () => {
			if (onUpdate) {
				const running = allResults.filter((r) => !r.completed).length;
				const done = allResults.filter((r) => r.completed).length;
				onUpdate({
					content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` }],
					details: makeDetails("parallel")([...allResults]),
				});
			}
		};

		const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t: any, index: number) => {
			const result = await runSingleAgent(
				cwd, agents, t.agent, t.task, t.cwd, undefined, signal,
				(partial) => {
					if (partial.details?.results[0]) {
						allResults[index] = partial.details.results[0];
						emitParallelUpdate();
					}
				},
				makeDetails("parallel"),
				undefined, false,
			);
			allResults[index] = result;
			emitParallelUpdate();
			return result;
		});

		const successCount = results.filter((r) => r.exitCode === 0).length;
		const summaries = results.map((r) => {
			const output = getFinalOutput(r.messages);
			const preview = output.slice(0, 100) + (output.length > 100 ? "..." : "");
			return `[${r.agent}] ${r.exitCode === 0 ? "completed" : "failed"}: ${preview || "(no output)"}`;
		});
		return {
			content: [{ type: "text", text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}` }],
			details: makeDetails("parallel")(results),
		};
	}

	if (params.agent && params.task) {
		const result = await runSingleAgent(
			cwd, agents, params.agent, params.task, params.cwd, undefined, signal, onUpdate, makeDetails("single"),
			sessionId,
		);
		const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
		if (isError) {
			const errorMsg = result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
			const sessionInfo = result.sessionId ? `\n\n[sessionId: ${result.sessionId}]` : "";
			return {
				content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}${sessionInfo}` }],
				details: makeDetails("single")([result]),
				isError: true,
			};
		}
		const output = getFinalOutput(result.messages) || "(no output)";
		const sessionInfo = result.sessionId ? `\n\n[sessionId: ${result.sessionId}]` : "";
		return {
			content: [{ type: "text", text: output + sessionInfo }],
			details: makeDetails("single")([result]),
		};
	}

	const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
	return {
		content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
		details: makeDetails("single")([]),
	};
}

export default function (pi: ExtensionAPI) {
	// --- Widget: show background job count ---
	let latestCtx: ExtensionContext | null = null;
	let widgetRefreshTimer: ReturnType<typeof setInterval> | null = null;

	function stopWidgetRefresh() {
		if (widgetRefreshTimer) {
			clearInterval(widgetRefreshTimer);
			widgetRefreshTimer = null;
		}
	}

	function startWidgetRefresh() {
		if (widgetRefreshTimer) return;
		widgetRefreshTimer = setInterval(() => {
			if (!latestCtx?.hasUI) return;
			updateWidget(latestCtx);
		}, JOB_WIDGET_REFRESH_MS);
	}

	function updateWidget(ctx?: ExtensionContext) {
		if (!ctx?.hasUI) {
			stopWidgetRefresh();
			return;
		}

		const runningJobs = getRunningJobs();
		if (runningJobs.length === 0) {
			ctx.ui.setWidget("subagent-jobs", undefined);
			stopWidgetRefresh();
			return;
		}

		startWidgetRefresh();
		const lines: string[] = [`⏳ ${runningJobs.length} background job${runningJobs.length > 1 ? "s" : ""} running`];
		for (const job of runningJobs.slice(0, JOB_WIDGET_MAX_ITEMS)) {
			lines.push(formatJobWidgetLine(job));
		}
		if (runningJobs.length > JOB_WIDGET_MAX_ITEMS) {
			lines.push(`… +${runningJobs.length - JOB_WIDGET_MAX_ITEMS} more`);
		}
		ctx.ui.setWidget("subagent-jobs", lines);
	}

	// Store ctx reference for background job completion notifications

	pi.on("agent_start", async (_event, ctx) => {
		latestCtx = ctx;
		updateWidget(ctx);
	});

	// Abort all running background jobs and clean up sessions on process exit
	const abortAllJobs = () => {
		for (const job of backgroundJobs.values()) {
			if (job.status === "running" && job.abortController) {
				job.abortController.abort();
			}
		}
		// Clean up all session files
		for (const id of Array.from(subagentSessions.keys())) {
			cleanupSession(id);
		}
	};
	process.on("exit", abortAllJobs);
	process.on("SIGINT", abortAllJobs);
	process.on("SIGTERM", abortAllJobs);

	// --- /jobs command ---
	pi.registerCommand("jobs", {
		description: "List background subagent jobs",
		handler: async (_args, ctx) => {
			if (backgroundJobs.size === 0) {
				ctx.ui.notify("No background jobs.", "info");
				return;
			}
			const lines: string[] = [];
			for (const job of backgroundJobs.values()) {
				lines.push(formatJobSummary(job));
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// --- subagent_jobs tool: LLM can query background job results ---
	pi.registerTool({
		name: "subagent_jobs",
		label: "Subagent Jobs",
		description: [
			"Query background subagent jobs.",
			"Actions: list (show all jobs), get (retrieve result or latest progress by job ID), clear (remove finished jobs).",
		].join(" "),
		parameters: Type.Object({
			action: StringEnum(["list", "get", "clear"] as const, {
				description: "Action to perform",
			}),
			jobId: Type.Optional(Type.String({ description: 'Job ID to retrieve (for "get" action)' })),
		}),

		async execute(_toolCallId, params) {
			if (params.action === "list") {
				if (backgroundJobs.size === 0) {
					return { content: [{ type: "text", text: "No background jobs." }] };
				}
				const lines: string[] = [];
				for (const job of backgroundJobs.values()) {
					lines.push(formatJobSummary(job));
				}
				return { content: [{ type: "text", text: lines.join("\n") }] };
			}

			if (params.action === "get") {
				if (!params.jobId) {
					return { content: [{ type: "text", text: "Missing jobId parameter." }], isError: true };
				}
				const job = backgroundJobs.get(params.jobId);
				if (!job) {
					return {
						content: [{ type: "text", text: `Job not found: ${params.jobId}` }],
						isError: true,
					};
				}
				if (job.status === "running") {
					const elapsed = ((Date.now() - job.startedAt) / 1000).toFixed(1);
					let text = `Job ${job.id} is still running (${elapsed}s elapsed). Agent: ${job.agent}, Task: ${job.task}`;
					if (job.lastSummary) {
						const age = job.lastUpdateAt ? ((Date.now() - job.lastUpdateAt) / 1000).toFixed(1) : null;
						text += `\n\nLatest update${age ? ` (${age}s ago)` : ""}:\n${job.lastSummary}`;
					} else {
						text += "\n\n(no output yet)";
					}
					text += "\n\nA notification will appear when the job finishes. Continue with other work.";
					return {
						content: [
							{
								type: "text",
								text,
							},
						],
					};
				}
				if (job.result) {
					return {
						content: job.result.content,
						details: job.result.details,
						isError: job.result.isError,
					};
				}
				return { content: [{ type: "text", text: `Job ${job.id}: ${job.status} (no result data)` }] };
			}

			if (params.action === "clear") {
				let cleared = 0;
				for (const [id, job] of backgroundJobs.entries()) {
					if (job.status !== "running") {
						backgroundJobs.delete(id);
						cleared++;
					}
				}
				return { content: [{ type: "text", text: `Cleared ${cleared} finished job(s).` }] };
			}

			return { content: [{ type: "text", text: `Unknown action: ${params.action}` }], isError: true };
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("subagent_jobs ")) + theme.fg("accent", args.action || "?");
			if (args.jobId) text += theme.fg("dim", ` ${args.jobId}`);
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});

	// --- Main subagent tool ---
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			'Default agent scope is "user" (from ~/.pi/agent/agents).',
			'To enable project-local agents in .pi/agents, set agentScope: "both" (or "project").',
			"Set background: true to run in background and continue chatting.",
			"To resume a previous conversation with a subagent, pass the sessionId from the previous result.",
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if (params.sessionId && !hasSingle) {
				return {
					content: [
						{
							type: "text",
							text: "sessionId can only be used with single mode (agent + task). It is not supported for chain or parallel.",
						},
					],
					details: makeDetails(hasChain ? "chain" : "parallel")([]),
				};
			}

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			// --- Background mode: dispatch and return immediately ---
			if (params.background) {
				const jobId = generateJobId();
				evictOldJobs();
				const mode = hasChain ? "chain" : hasTasks ? "parallel" : "single";
				const agentName = params.agent || (params.chain?.[0]?.agent) || (params.tasks?.[0]?.agent) || "unknown";
				const taskDesc = params.task || (params.chain?.[0]?.task) || (params.tasks?.map((t) => t.agent).join(", ")) || "unknown";

				const abortController = new AbortController();
				const job: BackgroundJob = {
					id: jobId,
					status: "running",
					agent: agentName,
					task: taskDesc,
					mode,
					startedAt: Date.now(),
					abortController,
				};
				backgroundJobs.set(jobId, job);
				updateWidget(ctx);

				// Clone params without background flag, run asynchronously
				const fgParams = { ...params, background: false };
				const capturedCwd = ctx.cwd;

				const recordProgress: OnUpdateCallback = (partial) => {
					const details = partial.details as SubagentDetails | undefined;
					let summary = details ? summarizeProgress(details, true) : "";
					if (!summary) {
						const textPart = partial.content?.find((part) => part.type === "text") as
							| { type: "text"; text: string }
							| undefined;
						if (textPart?.text) summary = formatPreviewText(textPart.text);
					}
					if (summary) {
						job.lastSummary = summary;
						job.lastUpdateAt = Date.now();
					}
				};

				// Fire and forget — run the same execute logic in background
				(async () => {
					try {
						const bgResult = await runForegroundExecution(
							fgParams, capturedCwd, agents, agentScope, discovery, makeDetails, abortController.signal, recordProgress, fgParams.sessionId,
						);
						job.status = bgResult.isError ? "failed" : "completed";
						job.finishedAt = Date.now();
						job.result = {
							content: bgResult.content as Array<{ type: "text"; text: string }>,
							details: bgResult.details as SubagentDetails,
							isError: bgResult.isError,
						};
					} catch (err: any) {
						job.status = "failed";
						job.finishedAt = Date.now();
						job.result = {
							content: [{ type: "text", text: `Background job error: ${err?.message ?? err}` }],
							details: makeDetails(mode)([]),
							isError: true,
						};
					}
					updateWidget(latestCtx);
					// Notify user
					const elapsed = ((job.finishedAt! - job.startedAt) / 1000).toFixed(1);
					const icon = job.status === "completed" ? "✓" : "✗";
					if (latestCtx?.ui?.notify) {
						latestCtx.ui.notify(
							`${icon} Background job ${jobId} ${job.status} (${elapsed}s)\nAgent: ${job.agent}\nUse subagent_jobs with action "get" and jobId "${jobId}" to retrieve the result.`,
							job.status === "completed" ? "info" : "error",
						);
					}
				})();

				return {
					content: [
						{
							type: "text",
							text: `Background job started: ${jobId}\nAgent: ${agentName}, Mode: ${mode}\nA notification will appear when the job finishes. Continue with other work and retrieve results after the notification.`,
						},
					],
					details: makeDetails(mode)([]),
				};
			}

			return runForegroundExecution(params, ctx.cwd, agents, agentScope, discovery, makeDetails, signal, onUpdate, params.sessionId);
		},

		renderCall(args, theme) {
			const scope: AgentScope = args.agentScope ?? "user";
			const bgTag = args.background ? theme.fg("warning", " [bg]") : "";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`) + bgTag;
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`) + bgTag;
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			const resumeTag = args.sessionId ? theme.fg("accent", ` ↩ ${args.sessionId}`) : "";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`) + bgTag + resumeTag;
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					if (r.sessionId) {
						container.addChild(new Text(theme.fg("dim", `session: ${r.sessionId}`), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				if (r.sessionId) text += `\n${theme.fg("dim", `session: ${r.sessionId}`)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => !r.completed).length;
				const successCount = details.results.filter((r) => r.completed && r.exitCode === 0).length;
				const failCount = details.results.filter((r) => r.completed && r.exitCode > 0).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						!r.completed
							? theme.fg("warning", "⏳")
							: r.exitCode === 0
								? theme.fg("success", "✓")
								: theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", !r.completed ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
}
