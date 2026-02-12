/**
 * Copilot Models Extension
 *
 * Discovers and registers additional GitHub Copilot models by querying
 * the live /models API endpoint. Runs automatically on session start
 * and provides a /copilot-models command for manual refresh.
 *
 * Prerequisites: Must be logged in via `/login github-copilot` first.
 */

import type { Api, Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

// --- Types for the Copilot /models API response ---

interface CopilotModelCapabilities {
	family: string;
	limits: {
		max_context_window_tokens?: number;
		max_output_tokens?: number;
	};
	supports: {
		tool_calls?: boolean;
	};
}

interface CopilotModel {
	id: string;
	name: string;
	vendor: string;
	capabilities: CopilotModelCapabilities;
	model_picker_enabled: boolean;
	supported_endpoints?: ("/chat/completions" | "/responses" | "/v1/messages")[];
	preview: boolean;
}

interface ModelsResponse {
	data: CopilotModel[];
	object: string;
}

// --- Families known to support reasoning ---
const REASONING_FAMILIES = [
	"claude",       // Claude models with extended thinking
	"o1",
	"o3",
	"o4",
	"gpt-5",        // GPT-5 series
	"deepseek-r1",
	"grok-code",
	"gemini-3",
];

/** Check if a model ID or family suggests reasoning support */
function isReasoningModel(model: CopilotModel): boolean {
	const id = model.id.toLowerCase();
	const family = model.capabilities.family.toLowerCase();

	for (const rf of REASONING_FAMILIES) {
		if (family.startsWith(rf) || id.startsWith(rf)) return true;
	}

	// Specific ID patterns
	if (/\bo[134]-/.test(id)) return true;
	if (id.includes("deepseek-r1")) return true;
	if (id.includes("grok-code")) return true;

	return false;
}

/** Check if a vendor typically supports vision/image input */
function supportsVision(vendor: string): boolean {
	const v = vendor.toLowerCase();
	return v === "anthropic" || v === "openai" || v === "google" || v === "xai";
}

/** Determine the API type based on supported_endpoints */
function determineApi(model: CopilotModel): Api {
	const endpoints = model.supported_endpoints;
	if (!endpoints || endpoints.length === 0) return "openai-completions";

	const hasResponses = endpoints.includes("/responses");
	const hasCompletions = endpoints.includes("/chat/completions");

	// If ONLY responses (no completions), use responses API
	if (hasResponses && !hasCompletions) return "openai-responses";

	// Default to completions (most compatible)
	return "openai-completions";
}

// --- Fetch models from the Copilot API ---

async function fetchCopilotModels(
	baseUrl: string,
	token: string,
	headers: Record<string, string>,
): Promise<ModelsResponse | null> {
	try {
		const url = `${baseUrl}/models`;
		const response = await fetch(url, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/json",
				...headers,
			},
		});

		if (!response.ok) {
			return null;
		}

		return (await response.json()) as ModelsResponse;
	} catch {
		return null;
	}
}

// --- Map a CopilotModel to a ProviderModelConfig ---

interface ProviderModelConfig {
	id: string;
	name: string;
	api?: Api;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	headers?: Record<string, string>;
	compat?: Model<Api>["compat"];
}

function mapToProviderModelConfig(
	model: CopilotModel,
	existingHeaders: Record<string, string>,
): ProviderModelConfig {
	const api = determineApi(model);

	const config: ProviderModelConfig = {
		id: model.id,
		name: model.name,
		api,
		reasoning: isReasoningModel(model),
		input: supportsVision(model.vendor) ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: model.capabilities.limits.max_context_window_tokens ?? 128000,
		maxTokens: model.capabilities.limits.max_output_tokens ?? 16000,
		headers: { ...existingHeaders },
	};

	// Add compat settings for openai-completions models
	if (api === "openai-completions") {
		config.compat = {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
		};
	}

	return config;
}

// --- Convert existing Model to ProviderModelConfig ---

function modelToConfig(model: Model<Api>): ProviderModelConfig {
	const config: ProviderModelConfig = {
		id: model.id,
		name: model.name,
		api: model.api,
		reasoning: model.reasoning,
		input: [...model.input],
		cost: { ...model.cost },
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
	};

	if (model.headers) {
		config.headers = { ...model.headers };
	}
	if (model.compat) {
		config.compat = { ...model.compat } as Model<Api>["compat"];
	}

	return config;
}

// --- Extension entry point ---

export default function copilotModelsExtension(pi: ExtensionAPI): void {
	let addedModelIds: string[] = [];

	async function discoverAndRegister(
		ctx: ExtensionContext,
	): Promise<{ added: string[]; skipped: boolean; error?: string }> {
		// Get all existing github-copilot models
		const existingModels = ctx.modelRegistry.getAll().filter((m) => m.provider === "github-copilot");

		if (existingModels.length === 0) {
			return { added: [], skipped: true };
		}

		// Extract baseUrl and headers from first existing model
		const firstModel = existingModels[0];
		const baseUrl = firstModel.baseUrl;
		const headers = firstModel.headers ?? {};

		// Get the Copilot token
		const token = await ctx.modelRegistry.getApiKeyForProvider("github-copilot");
		if (!token) {
			return { added: [], skipped: true };
		}

		// Fetch available models from the API
		const response = await fetchCopilotModels(baseUrl, token, headers);
		if (!response || !response.data) {
			return { added: [], skipped: false, error: "Failed to fetch models from Copilot API" };
		}

		// Filter: only models enabled in the model picker that support tool calls
		// (tool_calls is required for pi's agentic workflow)
		const chatModels = response.data.filter(
			(m) => m.model_picker_enabled && m.capabilities.supports.tool_calls,
		);

		// Compute diff: find model IDs not already registered
		const existingIds = new Set(existingModels.map((m) => m.id));
		const newCopilotModels = chatModels.filter((m) => !existingIds.has(m.id));

		if (newCopilotModels.length === 0) {
			return { added: [], skipped: false };
		}

		// Map new models to config
		const newConfigs = newCopilotModels.map((m) => mapToProviderModelConfig(m, headers));

		// Convert existing models to config format (preserve them)
		const existingConfigs = existingModels.map(modelToConfig);

		// Register all models (existing + new) for the provider
		// NOTE: Must use ctx.modelRegistry.registerProvider() directly, not pi.registerProvider().
		// pi.registerProvider() only queues to pendingProviderRegistrations which is drained
		// once during bindCore(). After init, the queue is never processed again.
		try {
			ctx.modelRegistry.registerProvider("github-copilot", {
				baseUrl,
				apiKey: "COPILOT_GITHUB_TOKEN",
				models: [...existingConfigs, ...newConfigs],
			});
		} catch (err: any) {
			return {
				added: [],
				skipped: false,
				error: `registerProvider failed: ${err?.message ?? err}`,
			};
		}

		// Verify models were actually registered
		const afterModels = ctx.modelRegistry.getAll().filter((m) => m.provider === "github-copilot");
		const afterIds = new Set(afterModels.map((m) => m.id));
		const actuallyAdded = newConfigs.filter((c) => afterIds.has(c.id)).map((c) => c.id);

		addedModelIds = actuallyAdded;
		return { added: actuallyAdded, skipped: false };
	}

	// --- session_start: auto-discover models ---

	pi.on("session_start", async (_event, ctx) => {
		const result = await discoverAndRegister(ctx);

		if (result.skipped) {
			return;
		}

		if (result.error) {
			ctx.ui.notify(`Copilot models: ${result.error}`, "warning");
			return;
		}

		if (result.added.length > 0) {
			ctx.ui.setStatus(
				"copilot-models",
				ctx.ui.theme.fg("accent", `🤖 +${result.added.length} copilot`),
			);
			ctx.ui.notify(
				`Copilot models discovered: +${result.added.length}\n${result.added.join(", ")}`,
				"info",
			);
		} else {
			ctx.ui.setStatus("copilot-models", undefined);
		}
	});

	// --- /copilot-models command: list and refresh ---

	pi.registerCommand("copilot-models", {
		description: "List/refresh GitHub Copilot models from live API",
		handler: async (args, ctx) => {
			const arg = args?.trim();

			if (arg === "refresh") {
				ctx.ui.notify("Refreshing Copilot models...", "info");
				const result = await discoverAndRegister(ctx);

				if (result.skipped) {
					ctx.ui.notify(
						"No github-copilot models found. Log in first with /login github-copilot",
						"error",
					);
					return;
				}

				if (result.error) {
					ctx.ui.notify(`Refresh failed: ${result.error}`, "error");
					return;
				}

				if (result.added.length > 0) {
					ctx.ui.setStatus(
						"copilot-models",
						ctx.ui.theme.fg("accent", `🤖 +${result.added.length} copilot`),
					);
					ctx.ui.notify(
						`Refreshed! Added ${result.added.length} new models:\n${result.added.join(", ")}`,
						"info",
					);
				} else {
					ctx.ui.notify("All Copilot models already registered.", "info");
				}
				return;
			}

			if (arg === "debug") {
				// Debug: show raw API response vs registered models
				const existingModels = ctx.modelRegistry.getAll().filter((m) => m.provider === "github-copilot");
				if (existingModels.length === 0) {
					ctx.ui.notify("No github-copilot models registered. Log in first.", "error");
					return;
				}

				const firstModel = existingModels[0];
				const baseUrl = firstModel.baseUrl;
				const headers = firstModel.headers ?? {};
				const token = await ctx.modelRegistry.getApiKeyForProvider("github-copilot");
				if (!token) {
					ctx.ui.notify("No Copilot token available.", "error");
					return;
				}

				const response = await fetchCopilotModels(baseUrl, token, headers);
				if (!response || !response.data) {
					ctx.ui.notify("Failed to fetch models from API.", "error");
					return;
				}

				const existingIds = new Set(existingModels.map((m) => m.id));
				const lines: string[] = [
					`API returned ${response.data.length} models total:`,
					"",
				];
				for (const m of response.data) {
					const registered = existingIds.has(m.id) ? "✓" : "✗";
					const picker = m.model_picker_enabled ? "picker" : "no-picker";
					const tools = m.capabilities.supports.tool_calls ? "tools" : "no-tools";
					const endpoints = (m.supported_endpoints ?? []).join(",") || "none";
					lines.push(`  ${registered} ${m.id} — ${m.name} [${picker}] [${tools}] [${endpoints}]`);
				}

				lines.push("");
				lines.push(`Registered: ${existingModels.length} | API total: ${response.data.length}`);
				lines.push(`New (not registered): ${response.data.filter((m) => !existingIds.has(m.id)).length}`);
				lines.push(`Eligible (picker+tools, not registered): ${response.data.filter((m) => m.model_picker_enabled && m.capabilities.supports.tool_calls && !existingIds.has(m.id)).length}`);

				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			// Default: show all copilot models
			const allCopilot = ctx.modelRegistry.getAll().filter((m) => m.provider === "github-copilot");
			if (allCopilot.length === 0) {
				ctx.ui.notify(
					"No github-copilot models registered. Log in first with /login github-copilot",
					"error",
				);
				return;
			}

			const lines = allCopilot.map((m) => {
				const isNew = addedModelIds.includes(m.id);
				const tag = isNew ? " ★" : "";
				return `  ${m.id}${tag} — ${m.name} (${m.api})`;
			});

			ctx.ui.notify(
				`GitHub Copilot models (${allCopilot.length}, ★ = discovered):\n${lines.join("\n")}\n\nUse /copilot-models refresh to re-fetch\nUse /copilot-models debug to see raw API data`,
				"info",
			);
		},
	});
}
