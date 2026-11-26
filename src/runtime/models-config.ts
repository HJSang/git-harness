import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AnthropicAdapter, OpenAICompatAdapter } from "./adapters.ts";
import type { ModelAdapter } from "./types.ts";

export interface ModelDefinition {
  id: string;
  name?: string;
  reasoning?: boolean;
}

export interface ProviderConfig {
  baseUrl: string;
  api?: "openai-completions" | "anthropic-messages" | string;
  apiKey?: string;
  headers?: Record<string, string>;
  models?: ModelDefinition[];
}

export interface ModelsConfigFile {
  $schema?: string;
  providers: Record<string, ProviderConfig>;
}

/** Expand `$ENV_VAR` or `${ENV_VAR}` syntax without ever persisting secrets. */
export function resolveEnvRef(value: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  if (!value) return "";
  const match = value.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/);
  if (match) {
    return env[match[1]!] ?? "";
  }
  return value;
}

export function loadModelsConfig(filePath: string): ModelsConfigFile {
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw) as ModelsConfigFile;
  if (!parsed || typeof parsed !== "object" || !parsed.providers) {
    throw new Error(`Invalid models config at ${filePath}: missing 'providers' object`);
  }
  return parsed;
}

/** Search standard Pi-compatible config locations for `models.json`. */
export function findModelsConfigPath(explicitPath?: string, cwd = process.cwd()): string | null {
  const candidates = [
    explicitPath,
    process.env.HARNESS_MODELS_CONFIG,
    path.join(cwd, "models.json"),
    path.join(os.homedir(), ".git-harness", "models.json"),
    path.join(os.homedir(), ".pi", "agent", "models.json"),
  ].filter((p): p is string => Boolean(p));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export interface ResolveAdapterOptions {
  config: ModelsConfigFile;
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve a concrete `ModelAdapter` from a Pi-compatible `models.json` config.
 */
export function createAdapterFromModelsConfig(options: ResolveAdapterOptions): ModelAdapter | null {
  const env = options.env ?? process.env;
  const providerNames = Object.keys(options.config.providers);
  if (providerNames.length === 0) return null;

  let chosenName = options.provider;
  if (!chosenName && options.model) {
    // Allow selecting by model id alone if it exists in one of the configured providers.
    chosenName = providerNames.find((p) =>
      options.config.providers[p]?.models?.some((m) => m.id === options.model),
    );
  }
  if (!chosenName) {
    // Prefer the first provider whose resolved apiKey is actually present in env.
    chosenName =
      providerNames.find((p) => Boolean(resolveEnvRef(options.config.providers[p]?.apiKey, env))) ??
      providerNames[0]!;
  }

  const providerCfg = options.config.providers[chosenName];
  if (!providerCfg) {
    throw new Error(
      `Provider "${chosenName}" not found in models config (available: ${providerNames.join(", ")})`,
    );
  }

  const apiKey = options.apiKey ?? resolveEnvRef(providerCfg.apiKey, env);
  if (!apiKey) {
    const keyHint = providerCfg.apiKey?.startsWith("$") ? providerCfg.apiKey : "API key";
    throw new Error(`Missing ${keyHint} in environment for provider "${chosenName}"`);
  }

  const modelId = options.model ?? providerCfg.models?.[0]?.id;
  if (!modelId) {
    throw new Error(`No model id specified or defined under provider "${chosenName}"`);
  }

  const baseUrl = options.baseUrl ?? providerCfg.baseUrl;
  const api = (providerCfg.api ?? "openai-completions").toLowerCase();

  if (api === "anthropic-messages" || api === "anthropic") {
    return new AnthropicAdapter({
      model: modelId,
      apiKey,
      baseUrl,
      maxTokens: options.maxTokens,
    });
  }

  return new OpenAICompatAdapter({
    model: modelId,
    apiKey,
    baseUrl,
    extraHeaders: providerCfg.headers,
    maxTokens: options.maxTokens,
    temperature: options.temperature,
    reasoningEffort: options.reasoningEffort,
  });
}
