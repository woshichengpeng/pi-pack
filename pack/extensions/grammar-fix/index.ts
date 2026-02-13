/**
 * Grammar Fix Extension
 *
 * Automatically corrects English grammar using a cheap model (GPT-4o-mini, GPT-4o, Gemini Flash).
 * Does NOT consume the main agent's context — uses a separate `complete()` call.
 *
 * Two modes:
 * - Async (default): User input goes through immediately; grammar correction runs in background,
 *   results shown in widget. Corrected text is injected into LLM context via `context` event.
 * - Sync (`/grammar sync`): Blocks input, auto-replaces with corrected text before sending.
 *
 * Features:
 * - /grammar command to toggle on/off and switch sync mode
 * - Ctrl+Shift+G shortcut to manually fix editor text
 * - Widget shows corrections with change descriptions
 * - `context` event rewrites user messages so LLM sees correct English
 */

import { complete, type Api, type Model, type UserMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";

// ── Types ───────────────────────────────────────────────────────────────

interface GrammarResult {
	corrected: string;
	changes: string;
}

interface CheapModel {
	model: Model<Api>;
	apiKey: string;
}

// ── System Prompt ───────────────────────────────────────────────────────

const GRAMMAR_SYSTEM_PROMPT = `You are a grammar corrector. Fix grammar, spelling, and improve clarity of the following English text.

Rules:
- Fix grammar and spelling errors
- Keep the original meaning, tone, and intent
- Don't over-formalize — keep it natural
- If the text contains technical terms, code references, file paths, or tool names, keep them as-is
- If the text is already correct, return it unchanged

Return ONLY a JSON object, no markdown fences:
{"corrected": "the corrected text", "changes": "brief description of what was changed"}

If no changes needed:
{"corrected": "original text here", "changes": "none"}`;

// ── Model Selection ─────────────────────────────────────────────────────

const MODEL_CANDIDATES: Array<[string, string]> = [
	["github-copilot", "gpt-4o-mini"],
	["openai", "gpt-4o-mini"],
	["github-copilot", "gpt-4o"],
	["openai", "gpt-4o"],
	["google", "gemini-2.5-flash"],
];

async function findCheapModel(ctx: ExtensionContext): Promise<CheapModel | null> {
	for (const [provider, modelId] of MODEL_CANDIDATES) {
		const model = ctx.modelRegistry.find(provider, modelId);
		if (!model) continue;
		const apiKey = await ctx.modelRegistry.getApiKey(model);
		if (apiKey) return { model, apiKey };
	}
	return null;
}

// ── Grammar Fix Core ────────────────────────────────────────────────────

function shouldSkip(text: string): boolean {
	const trimmed = text.trim();
	// Skip commands
	if (trimmed.startsWith("/")) return true;
	// Skip too short
	if (trimmed.length < 5) return true;
	// Skip if mostly non-Latin characters (CJK, etc.) — not English
	const nonLatinCount = (trimmed.match(/[\u3000-\u9fff\uac00-\ud7af\u0400-\u04ff]/g) || []).length;
	if (nonLatinCount > trimmed.length * 0.3) return true;
	// Skip if it looks like pure code (all lines start with common code patterns)
	const lines = trimmed.split("\n");
	const codePatterns = /^(import |export |const |let |var |function |class |if |for |while |return |\/\/|#|{|}|\s*$)/;
	if (lines.length > 1 && lines.every((l) => codePatterns.test(l))) return true;
	return false;
}

async function fixGrammar(
	text: string,
	model: Model<Api>,
	apiKey: string,
	signal?: AbortSignal,
): Promise<GrammarResult | null> {
	if (shouldSkip(text)) return null;

	try {
		const userMessage: UserMessage = {
			role: "user",
			content: [{ type: "text", text }],
			timestamp: Date.now(),
		};

		const response = await complete(
			model,
			{ systemPrompt: GRAMMAR_SYSTEM_PROMPT, messages: [userMessage] },
			{ apiKey, maxTokens: 2048, temperature: 0, signal },
		);

		if (response.stopReason === "aborted") return null;

		const responseText = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n")
			.trim();

		// Try to parse JSON from response (handle markdown fences if model wraps them)
		let jsonStr = responseText;
		const fenceMatch = responseText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
		if (fenceMatch) jsonStr = fenceMatch[1].trim();

		const parsed = JSON.parse(jsonStr);
		if (!parsed.corrected || typeof parsed.corrected !== "string") return null;

		// No changes needed
		if (parsed.changes === "none" || parsed.corrected.trim() === text.trim()) return null;

		return {
			corrected: parsed.corrected,
			changes: typeof parsed.changes === "string" ? parsed.changes : "minor corrections",
		};
	} catch {
		// Parse error or API error — silently skip
		return null;
	}
}

// ── Normalize text for matching ─────────────────────────────────────────

function normalizeForMatch(text: string): string {
	return text.trim().replace(/\s+/g, " ");
}

// ── Extension Entry Point ───────────────────────────────────────────────

export default function grammarFixExtension(pi: ExtensionAPI): void {
	// ── State (scoped to extension lifecycle) ────────────────────────────

	let enabled = true;
	let syncMode = false;

	// Map of normalized original text → corrected text, for context event rewriting
	const pendingCorrections = new Map<string, GrammarResult>();

	// AbortController for in-flight async corrections
	let asyncAbort: AbortController | null = null;

	// Cached model lookup (cleared on session switch)
	let cachedModel: CheapModel | null | undefined; // undefined = not yet looked up

	// Latest context reference for async widget updates
	let latestCtx: ExtensionContext | null = null;

	async function getCheapModel(ctx: ExtensionContext): Promise<CheapModel | null> {
		if (cachedModel !== undefined) return cachedModel;
		cachedModel = (await findCheapModel(ctx)) ?? null;
		return cachedModel;
	}

	// ── Status bar update ───────────────────────────────────────────────

	function updateStatus(ctx: ExtensionContext): void {
		if (!enabled) {
			ctx.ui.setStatus("grammar-fix", undefined);
			return;
		}
		const mode = syncMode ? "(sync)" : "";
		ctx.ui.setStatus("grammar-fix", ctx.ui.theme.fg("accent", `✏️ grammar${mode}`));
	}

	// ── Widget display ──────────────────────────────────────────────────

	function showCorrectionWidget(ctx: ExtensionContext, result: GrammarResult): void {
		const lines: string[] = [
			ctx.ui.theme.fg("accent", "✏️ Grammar Fix") +
				ctx.ui.theme.fg("dim", " (applied to LLM context)"),
			ctx.ui.theme.fg("success", `   "${result.corrected}"`),
			ctx.ui.theme.fg("dim", `   Changes: ${result.changes}`),
		];
		ctx.ui.setWidget("grammar-fix", lines);
	}

	function clearWidget(ctx: ExtensionContext): void {
		ctx.ui.setWidget("grammar-fix", undefined);
	}

	function resetState(): void {
		pendingCorrections.clear();
		asyncAbort?.abort();
		asyncAbort = null;
		cachedModel = undefined;
	}

	// ── Async correction (default mode) ─────────────────────────────────

	pi.on("before_agent_start", async (event, ctx) => {
		latestCtx = ctx;

		// Clear previous widget
		clearWidget(ctx);

		if (!enabled || syncMode) return;
		if (!event.prompt || shouldSkip(event.prompt)) return;

		// Cancel any in-flight correction
		if (asyncAbort) {
			asyncAbort.abort();
			asyncAbort = null;
		}

		const prompt = event.prompt;
		const controller = new AbortController();
		asyncAbort = controller;

		// Fire and forget — don't block the agent
		// NOTE: In async mode, the first LLM turn may see the original text
		// if the correction hasn't completed yet. Subsequent turns (after tool
		// calls) will see the corrected text via the context event.
		(async () => {
			try {
				const cheap = await getCheapModel(ctx);
				if (!cheap) return;

				const result = await fixGrammar(prompt, cheap.model, cheap.apiKey, controller.signal);
				if (!result) return;
				if (controller.signal.aborted) return;

				// Store correction for context event rewriting
				const key = normalizeForMatch(prompt);
				pendingCorrections.set(key, result);

				// Evict old corrections (keep last 20)
				if (pendingCorrections.size > 20) {
					const firstKey = pendingCorrections.keys().next().value!;
					pendingCorrections.delete(firstKey);
				}

				// Show widget if we still have a ctx
				if (latestCtx?.hasUI) {
					showCorrectionWidget(latestCtx, result);
				}
			} catch {
				// Silently ignore errors
			} finally {
				if (asyncAbort === controller) asyncAbort = null;
			}
		})();
	});

	// ── Context event: rewrite user messages for LLM ────────────────────

	pi.on("context", async (event) => {
		if (!enabled || pendingCorrections.size === 0) return;

		let modified = false;
		const messages = event.messages;

		// Walk messages in reverse to find user messages that need correction
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i] as any;
			if (msg.role !== "user") continue;

			// Extract text from user message content
			const content = msg.content;
			if (typeof content === "string") {
				const key = normalizeForMatch(content);
				const correction = pendingCorrections.get(key);
				if (correction) {
					msg.content = correction.corrected;
					modified = true;
				}
			} else if (Array.isArray(content)) {
				for (const part of content) {
					if (part.type === "text" && typeof part.text === "string") {
						const key = normalizeForMatch(part.text);
						const correction = pendingCorrections.get(key);
						if (correction) {
							part.text = correction.corrected;
							modified = true;
						}
					}
				}
			}
		}

		if (modified) {
			return { messages };
		}
	});

	// ── Sync mode: input event ──────────────────────────────────────────

	pi.on("input", async (event, ctx) => {
		if (!enabled || !syncMode) return { action: "continue" as const };
		if (event.source === "extension") return { action: "continue" as const };
		if (!event.text || shouldSkip(event.text)) return { action: "continue" as const };

		const cheap = await getCheapModel(ctx);
		if (!cheap) return { action: "continue" as const };

		const result = await fixGrammar(event.text, cheap.model, cheap.apiKey);
		if (!result) return { action: "continue" as const };

		ctx.ui.notify(
			`✏️ Grammar fixed:\n"${result.corrected}"\nChanges: ${result.changes}`,
			"info",
		);

		return { action: "transform" as const, text: result.corrected };
	});

	// ── Shortcut: Ctrl+Shift+G — manual fix editor text ─────────────────

	pi.registerShortcut(Key.ctrlShift("g"), {
		description: "Fix grammar of editor text",
		handler: async (ctx) => {
			const text = ctx.ui.getEditorText();
			if (!text || !text.trim()) {
				ctx.ui.notify("Editor is empty", "info");
				return;
			}

			const cheap = await getCheapModel(ctx);
			if (!cheap) {
				ctx.ui.notify("No grammar model available (need gpt-4o-mini, gpt-4o, or gemini-flash)", "error");
				return;
			}

			ctx.ui.setStatus("grammar-fix", ctx.ui.theme.fg("warning", "✏️ fixing..."));

			const result = await fixGrammar(text, cheap.model, cheap.apiKey);

			updateStatus(ctx);

			if (!result) {
				ctx.ui.notify("✓ Grammar looks correct!", "info");
				return;
			}

			ctx.ui.setEditorText(result.corrected);
			showCorrectionWidget(ctx, result);
		},
	});

	// ── /grammar command ────────────────────────────────────────────────

	pi.registerCommand("grammar", {
		description: "Toggle grammar correction (async/sync/off)",
		handler: async (args, ctx) => {
			const arg = args?.trim().toLowerCase();

			if (arg === "sync") {
				syncMode = !syncMode;
				ctx.ui.notify(
					syncMode
						? "Grammar: sync mode ON — input will be auto-corrected before sending"
						: "Grammar: sync mode OFF — corrections shown after sending (async)",
					"info",
				);
				updateStatus(ctx);
				return;
			}

			if (arg === "off") {
				enabled = false;
				syncMode = false;
				resetState();
				clearWidget(ctx);
				ctx.ui.notify("Grammar correction disabled", "info");
				updateStatus(ctx);
				return;
			}

			if (arg === "on") {
				enabled = true;
				syncMode = false;
				cachedModel = undefined; // Re-discover model on next use
				ctx.ui.notify("Grammar correction enabled (async mode)", "info");
				updateStatus(ctx);
				return;
			}

			if (arg === "model") {
				const cheap = await getCheapModel(ctx);
				if (cheap) {
					ctx.ui.notify(`Grammar model: ${cheap.model.provider}/${cheap.model.id}`, "info");
				} else {
					ctx.ui.notify("No grammar model available", "error");
				}
				return;
			}

			// Default: toggle
			enabled = !enabled;
			if (!enabled) {
				syncMode = false;
				resetState();
				clearWidget(ctx);
			}
			ctx.ui.notify(enabled ? "Grammar correction enabled" : "Grammar correction disabled", "info");
			updateStatus(ctx);
		},
	});

	// ── Session start: restore status, clear stale state ────────────────

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		resetState();
		updateStatus(ctx);
	});
}
