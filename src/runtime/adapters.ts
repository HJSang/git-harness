import type { Message, ToolCallRecord } from "../session/types.ts";
import type { ModelAdapter, ModelRequest, ModelResponse } from "./types.ts";

/**
 * Zero-dependency Server-Sent Events (SSE) stream parser for OpenAI & Anthropic APIs.
 */
async function readSseEvents(
  body: ReadableStream<Uint8Array>,
  onEvent: (eventName: string, data: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";
  let dataLines: string[] = [];

  const flush = () => {
    if (dataLines.length > 0) {
      onEvent(eventName, dataLines.join("\n"));
      dataLines = [];
    }
    eventName = "message";
  };

  const processLine = (rawLine: string) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "") {
      flush();
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") {
      eventName = value || "message";
    } else if (field === "data") {
      dataLines.push(value);
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx = buffer.indexOf("\n");
      while (idx !== -1) {
        processLine(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
        idx = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) processLine(buffer);
    flush();
  } finally {
    reader.releaseLock();
  }
}

export interface OpenAICompatAdapterOptions {
  model: string;
  apiKey: string;
  /** Defaults to `https://api.openai.com/v1` (also works for DeepSeek, OpenRouter, vLLM, Ollama). */
  baseUrl?: string;
  extraHeaders?: Record<string, string>;
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: string;
  maxRetries?: number;
}

/**
 * Zero-dependency OpenAI-compatible Chat Completions adapter (OpenAI, DeepSeek,
 * OpenRouter, vLLM, SGLang, Ollama) using Node's native `fetch`.
 */
export class OpenAICompatAdapter implements ModelAdapter {
  public readonly id: string;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly maxTokens?: number;
  private readonly temperature?: number;
  private readonly reasoningEffort?: string;
  private readonly maxRetries: number;

  constructor(options: OpenAICompatAdapterOptions) {
    this.model = options.model;
    this.id = options.model;
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    this.extraHeaders = options.extraHeaders ?? {};
    this.maxTokens = options.maxTokens;
    this.temperature = options.temperature;
    this.reasoningEffort = options.reasoningEffort;
    this.maxRetries = options.maxRetries ?? 3;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const messages = request.messages.map((m) => {
      if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
        return {
          role: "assistant",
          content: m.content || null,
          ...(m.thinking ? { reasoning_content: m.thinking } : {}),
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: tc.arguments },
          })),
        };
      }
      if (m.role === "assistant") {
        return {
          role: "assistant",
          content: m.content,
          ...(m.thinking ? { reasoning_content: m.thinking } : {}),
        };
      }
      if (m.role === "tool") {
        const content =
          m.images && m.images.length > 0
            ? [
                { type: "text", text: m.content },
                ...m.images.map((img) => ({
                  type: "image_url",
                  image_url: { url: `data:${img.mimeType};base64,${img.data}` },
                })),
              ]
            : m.content;
        return {
          role: "tool",
          tool_call_id: m.toolCallId ?? "unknown",
          ...(m.name ? { name: m.name } : {}),
          content,
        };
      }
      if (m.role === "user" && m.images && m.images.length > 0) {
        return {
          role: "user",
          content: [
            { type: "text", text: m.content },
            ...m.images.map((img) => ({
              type: "image_url",
              image_url: { url: `data:${img.mimeType};base64,${img.data}` },
            })),
          ],
        };
      }
      return { role: m.role, content: m.content };
    });

    const wantsStream = Boolean(request.onDelta);
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
    };
    if (wantsStream) {
      body.stream = true;
      body.stream_options = { include_usage: true };
    }
    if (this.maxTokens !== undefined) body.max_tokens = this.maxTokens;
    if (this.temperature !== undefined) body.temperature = this.temperature;
    if (this.reasoningEffort !== undefined) body.reasoning_effort = this.reasoningEffort;
    if (request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
    }

    let res: Response | null = null;
    let lastErrText = "";
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        res = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.apiKey}`,
            ...this.extraHeaders,
          },
          body: JSON.stringify(body),
          signal: request.signal,
        });
        if (res.ok || (res.status < 500 && res.status !== 429)) {
          break;
        }
        lastErrText = await res.text();
      } catch (err) {
        if (attempt === this.maxRetries) throw err;
        lastErrText = (err as Error).message;
      }
      if (attempt < this.maxRetries) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
    }

    if (!res || !res.ok) {
      const errText = res ? lastErrText || (await res.text()) : lastErrText;
      throw new Error(`OpenAICompatAdapter HTTP ${res?.status ?? 0}: ${errText}`);
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (wantsStream && res.body && contentType.includes("text/event-stream")) {
      let content = "";
      let thinking = "";
      let finishReason: string | undefined;
      let usage: ModelResponse["usage"];
      const toolCallsByIndex = new Map<number, { id: string; name: string; arguments: string }>();

      await readSseEvents(res.body, (_event, data) => {
        if (!data || data === "[DONE]") return;
        let chunk: {
          choices?: Array<{
            finish_reason?: string | null;
            delta?: {
              content?: string | null;
              reasoning_content?: string | null;
              tool_calls?: Array<{
                index?: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
          }>;
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            prompt_tokens_details?: { cached_tokens?: number };
            prompt_cache_hit_tokens?: number;
          };
        };
        try {
          chunk = JSON.parse(data);
        } catch {
          return;
        }
        if (chunk.usage) {
          usage = {
            tokensIn: chunk.usage.prompt_tokens,
            tokensOut: chunk.usage.completion_tokens,
            cacheRead:
              chunk.usage.prompt_tokens_details?.cached_tokens ??
              chunk.usage.prompt_cache_hit_tokens,
          };
        }
        const choice = chunk.choices?.[0];
        if (!choice) return;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta;
        if (!delta) return;
        if (delta.reasoning_content) {
          thinking += delta.reasoning_content;
          request.onDelta?.({ type: "thinking", text: delta.reasoning_content });
        }
        if (delta.content) {
          content += delta.content;
          request.onDelta?.({ type: "text", text: delta.content });
        }
        for (const tc of delta.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          const cur = toolCallsByIndex.get(idx) ?? { id: "", name: "", arguments: "" };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.arguments += tc.function.arguments;
          toolCallsByIndex.set(idx, cur);
        }
      });

      const toolCalls: ToolCallRecord[] = [...toolCallsByIndex.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, tc], i) => ({
          id: tc.id || `call_${i}`,
          name: tc.name,
          arguments: tc.arguments,
        }));

      return {
        content,
        thinking: thinking || undefined,
        toolCalls,
        usage,
        stopReason:
          finishReason === "tool_calls"
            ? "tool_use"
            : finishReason === "length"
              ? "max_tokens"
              : "end_turn",
      };
    }

    const data = (await res.json()) as {
      choices?: Array<{
        finish_reason?: string;
        message?: {
          content?: string | null;
          reasoning_content?: string | null;
          tool_calls?: Array<{
            id: string;
            function: { name: string; arguments: string };
          }>;
        };
      }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
        prompt_cache_hit_tokens?: number;
      };
    };

    const choice = data.choices?.[0];
    const msg = choice?.message;
    const toolCalls: ToolCallRecord[] = (msg?.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
    }));

    const contentText = msg?.content ?? "";
    const thinkingText = msg?.reasoning_content ?? undefined;
    if (wantsStream) {
      if (thinkingText) request.onDelta?.({ type: "thinking", text: thinkingText });
      if (contentText) request.onDelta?.({ type: "text", text: contentText });
    }

    return {
      content: contentText,
      thinking: thinkingText,
      toolCalls,
      usage: data.usage
        ? {
            tokensIn: data.usage.prompt_tokens,
            tokensOut: data.usage.completion_tokens,
            cacheRead:
              data.usage.prompt_tokens_details?.cached_tokens ??
              data.usage.prompt_cache_hit_tokens,
          }
        : undefined,
      stopReason:
        choice?.finish_reason === "tool_calls"
          ? "tool_use"
          : choice?.finish_reason === "length"
            ? "max_tokens"
            : "end_turn",
    };
  }
}

export interface AnthropicAdapterOptions {
  model: string;
  apiKey: string;
  baseUrl?: string;
  maxTokens?: number;
  reasoningEffort?: string;
  maxRetries?: number;
}

/**
 * Zero-dependency Anthropic Messages API adapter with rolling prompt-cache
 * breakpoints (system, tools, and latest turn) and adaptive thinking support.
 */
export class AnthropicAdapter implements ModelAdapter {
  public readonly id: string;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly maxTokens: number;
  private readonly reasoningEffort?: string;
  private readonly maxRetries: number;

  constructor(options: AnthropicAdapterOptions) {
    this.model = options.model;
    this.id = options.model;
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
    this.maxTokens = options.maxTokens ?? 64000;
    this.reasoningEffort = options.reasoningEffort;
    this.maxRetries = options.maxRetries ?? 4;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const systemBlocks: Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }> = [];
    const converted: Array<{ role: "user" | "assistant"; content: unknown }> = [];

    for (const m of request.messages) {
      if (m.role === "system") {
        systemBlocks.push({ type: "text", text: m.content, cache_control: { type: "ephemeral" } });
        continue;
      }
      if (m.role === "assistant") {
        const blocks: unknown[] = [];
        if (m.content) blocks.push({ type: "text", text: m.content });
        for (const tc of m.toolCalls ?? []) {
          let input: unknown = {};
          try {
            input = JSON.parse(tc.arguments);
          } catch {
            input = { raw: tc.arguments };
          }
          blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input });
        }
        converted.push({ role: "assistant", content: blocks.length > 0 ? blocks : "" });
      } else if (m.role === "tool") {
        const toolContent =
          m.images && m.images.length > 0
            ? [
                { type: "text", text: m.content },
                ...m.images.map((img) => ({
                  type: "image",
                  source: { type: "base64", media_type: img.mimeType, data: img.data },
                })),
              ]
            : m.content;
        const block = {
          type: "tool_result",
          tool_use_id: m.toolCallId ?? "unknown",
          content: toolContent,
        };
        const prev = converted.at(-1);
        if (prev && prev.role === "user" && Array.isArray(prev.content)) {
          prev.content.push(block);
        } else {
          converted.push({ role: "user", content: [block] });
        }
      } else {
        const userContent =
          m.images && m.images.length > 0
            ? [
                { type: "text", text: m.content },
                ...m.images.map((img) => ({
                  type: "image",
                  source: { type: "base64", media_type: img.mimeType, data: img.data },
                })),
              ]
            : m.content;
        converted.push({ role: "user", content: userContent });
      }
    }

    // Place a rolling ephemeral prompt-cache breakpoint on the final message so
    // Anthropic caches the full multi-turn prefix across consecutive tool steps.
    const lastMsg = converted.at(-1);
    if (lastMsg) {
      if (typeof lastMsg.content === "string" && lastMsg.content.length > 0) {
        lastMsg.content = [
          { type: "text", text: lastMsg.content, cache_control: { type: "ephemeral" } },
        ];
      } else if (Array.isArray(lastMsg.content) && lastMsg.content.length > 0) {
        const lastBlock = lastMsg.content.at(-1) as Record<string, unknown>;
        if (lastBlock && typeof lastBlock === "object") {
          lastBlock.cache_control = { type: "ephemeral" };
        }
      }
    }

    const wantsStream = Boolean(request.onDelta);
    // Anthropic requires streaming for high max_tokens requests (>16384) to avoid HTTP timeouts.
    const useStream = wantsStream || this.maxTokens > 16384;
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: this.maxTokens,
      messages: converted,
    };
    if (useStream) body.stream = true;
    if (systemBlocks.length > 0) body.system = systemBlocks;
    if (this.reasoningEffort && this.reasoningEffort !== "off" && this.reasoningEffort !== "none") {
      body.thinking = { type: "adaptive" };
      body.output_config = { effort: this.reasoningEffort };
    }
    if (request.tools.length > 0) {
      body.tools = request.tools.map((t, idx) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
        ...(idx === request.tools.length - 1 ? { cache_control: { type: "ephemeral" } } : {}),
      }));
    }

    let res: Response | null = null;
    let lastErrText = "";
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        res = await fetch(`${this.baseUrl}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": this.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify(body),
          signal: request.signal,
        });
        if (res.ok || (res.status < 500 && res.status !== 429 && res.status !== 529)) {
          break;
        }
        lastErrText = await res.text();
      } catch (err) {
        if (attempt === this.maxRetries) throw err;
        lastErrText = (err as Error).message;
      }
      if (attempt < this.maxRetries) {
        await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
      }
    }

    if (!res || !res.ok) {
      const errText = res ? lastErrText || (await res.text()) : lastErrText;
      throw new Error(`AnthropicAdapter HTTP ${res?.status ?? 0}: ${errText}`);
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (useStream && res.body && contentType.includes("text/event-stream")) {
      const blocks = new Map<
        number,
        { type: "text" | "thinking" | "tool_use"; text: string; id?: string; name?: string }
      >();
      let stopReason: string | undefined;
      let tokensIn: number | undefined;
      let tokensOut: number | undefined;
      let cacheRead: number | undefined;

      await readSseEvents(res.body, (eventName, data) => {
        if (!data) return;
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(data) as Record<string, unknown>;
        } catch {
          return;
        }
        const evType = (payload.type as string | undefined) ?? eventName;
        if (evType === "message_start") {
          const msg = payload.message as
            | {
                usage?: {
                  input_tokens?: number;
                  cache_creation_input_tokens?: number;
                  cache_read_input_tokens?: number;
                };
              }
            | undefined;
          if (msg?.usage) {
            const uncached = msg.usage.input_tokens ?? 0;
            const cacheCreate = msg.usage.cache_creation_input_tokens ?? 0;
            const cacheHit = msg.usage.cache_read_input_tokens ?? 0;
            tokensIn = uncached + cacheCreate + cacheHit;
            cacheRead = cacheHit;
          }
        } else if (evType === "content_block_start") {
          const idx = Number(payload.index ?? 0);
          const cb = payload.content_block as
            | { type?: string; text?: string; thinking?: string; id?: string; name?: string }
            | undefined;
          if (cb?.type === "text") {
            blocks.set(idx, { type: "text", text: cb.text ?? "" });
            if (cb.text) request.onDelta?.({ type: "text", text: cb.text });
          } else if (cb?.type === "thinking") {
            blocks.set(idx, { type: "thinking", text: cb.thinking ?? "" });
            if (cb.thinking) request.onDelta?.({ type: "thinking", text: cb.thinking });
          } else if (cb?.type === "tool_use") {
            blocks.set(idx, { type: "tool_use", text: "", id: cb.id, name: cb.name });
          }
        } else if (evType === "content_block_delta") {
          const idx = Number(payload.index ?? 0);
          const delta = payload.delta as
            | { type?: string; text?: string; thinking?: string; partial_json?: string }
            | undefined;
          const block = blocks.get(idx);
          if (!block || !delta) return;
          if (delta.type === "text_delta" && delta.text) {
            block.text += delta.text;
            request.onDelta?.({ type: "text", text: delta.text });
          } else if (delta.type === "thinking_delta" && delta.thinking) {
            block.text += delta.thinking;
            request.onDelta?.({ type: "thinking", text: delta.thinking });
          } else if (delta.type === "input_json_delta" && delta.partial_json) {
            block.text += delta.partial_json;
          }
        } else if (evType === "message_delta") {
          const delta = payload.delta as { stop_reason?: string } | undefined;
          const u = payload.usage as { output_tokens?: number } | undefined;
          if (delta?.stop_reason) stopReason = delta.stop_reason;
          if (u?.output_tokens !== undefined) tokensOut = u.output_tokens;
        }
      });

      const textParts: string[] = [];
      const thinkingParts: string[] = [];
      const toolCalls: ToolCallRecord[] = [];
      for (const [, b] of [...blocks.entries()].sort((a, b) => a[0] - b[0])) {
        if (b.type === "text") textParts.push(b.text);
        else if (b.type === "thinking") thinkingParts.push(b.text);
        else if (b.type === "tool_use") {
          toolCalls.push({
            id: b.id ?? "tool_0",
            name: b.name ?? "",
            arguments: b.text || "{}",
          });
        }
      }

      return {
        content: textParts.join("\n"),
        thinking: thinkingParts.length > 0 ? thinkingParts.join("\n") : undefined,
        toolCalls,
        usage:
          tokensIn !== undefined || tokensOut !== undefined || cacheRead !== undefined
            ? { tokensIn, tokensOut, cacheRead }
            : undefined,
        stopReason:
          stopReason === "tool_use"
            ? "tool_use"
            : stopReason === "max_tokens"
              ? "max_tokens"
              : stopReason === "refusal"
                ? "refusal"
                : "end_turn",
      };
    }

    const data = (await res.json()) as {
      stop_reason?: string;
      content?: Array<
        | { type: "text"; text: string }
        | { type: "thinking"; thinking: string }
        | { type: "tool_use"; id: string; name: string; input: unknown }
      >;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      };
    };

    const textParts: string[] = [];
    const thinkingParts: string[] = [];
    const toolCalls: ToolCallRecord[] = [];
    for (const block of data.content ?? []) {
      if (block.type === "text") textParts.push(block.text);
      else if (block.type === "thinking") thinkingParts.push(block.thinking);
      else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        });
      }
    }

    const contentText = textParts.join("\n");
    const thinkingText = thinkingParts.length > 0 ? thinkingParts.join("\n") : undefined;
    if (wantsStream) {
      if (thinkingText) request.onDelta?.({ type: "thinking", text: thinkingText });
      if (contentText) request.onDelta?.({ type: "text", text: contentText });
    }

    return {
      content: contentText,
      thinking: thinkingText,
      toolCalls,
      usage: data.usage
        ? {
            tokensIn:
              (data.usage.input_tokens ?? 0) +
              (data.usage.cache_creation_input_tokens ?? 0) +
              (data.usage.cache_read_input_tokens ?? 0),
            tokensOut: data.usage.output_tokens,
            cacheRead: data.usage.cache_read_input_tokens,
          }
        : undefined,
      stopReason:
        data.stop_reason === "tool_use"
          ? "tool_use"
          : data.stop_reason === "max_tokens"
            ? "max_tokens"
            : data.stop_reason === "refusal"
              ? "refusal"
              : "end_turn",
    };
  }
}

export type MockResponder = (request: ModelRequest, callIndex: number) => ModelResponse | Promise<ModelResponse>;

/**
 * Deterministic in-memory adapter for offline tests and replay evals.
 */
export class MockModelAdapter implements ModelAdapter {
  public readonly id: string;
  public readonly recordedRequests: Array<{ messages: Message[]; toolNames: string[] }> = [];
  private readonly responder: MockResponder;
  private callIndex = 0;

  constructor(id: string, responder: MockResponder) {
    this.id = id;
    this.responder = responder;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.recordedRequests.push({
      messages: request.messages.map((m) => ({ ...m })),
      toolNames: request.tools.map((t) => t.name),
    });
    return this.responder(request, this.callIndex++);
  }
}
