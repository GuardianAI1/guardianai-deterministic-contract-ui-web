import { NextRequest, NextResponse } from "next/server";
import { defaultModelForProvider, detectKeyProvider, normalizeApiKeyInput, resolveProvider } from "@/lib/providers";
import type { APIProvider } from "@/lib/types";

type RequestBody = {
  model?: string;
  prompt?: string;
  apiKey?: string;
  providerPreference?: APIProvider;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
};

const FETCH_TIMEOUT_MS = 30_000;
const MAX_RETRY_ATTEMPTS = 4;
const RETRYABLE_HTTP_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

function nonEmpty(value?: string): string | undefined {
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError";
}

function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError;
}

function parseRetryAfterMs(rawHeader: string | null): number | null {
  if (!rawHeader) return null;
  const numericSeconds = Number(rawHeader);
  if (Number.isFinite(numericSeconds) && numericSeconds >= 0) {
    return Math.floor(numericSeconds * 1000);
  }

  const epochMs = Date.parse(rawHeader);
  if (Number.isNaN(epochMs)) return null;
  return Math.max(0, epochMs - Date.now());
}

function retryDelayMs(attempt: number): number {
  const cappedAttempt = Math.max(1, Math.min(6, attempt));
  const base = 250 * 2 ** (cappedAttempt - 1);
  const jitter = Math.floor(Math.random() * 150);
  return Math.min(3000, base + jitter);
}

function payloadToMessage(payload: unknown): string {
  if (typeof payload === "string") {
    return payload;
  }
  if (payload && typeof payload === "object") {
    try {
      return JSON.stringify(payload);
    } catch {
      return "Unserializable payload";
    }
  }
  return String(payload);
}

class HTTPStatusError extends Error {
  status: number;
  payload: unknown;

  constructor(status: number, payload: unknown) {
    super(`HTTP ${status}: ${payloadToMessage(payload)}`);
    this.name = "HTTPStatusError";
    this.status = status;
    this.payload = payload;
  }
}

function providerFromServerEnv(): APIProvider | null {
  if (process.env.TOGETHER_API_KEY) return "together";
  if (process.env.OPENAI_API_KEY) return "openAI";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.GOOGLE_API_KEY) return "google";
  if (process.env.MISTRAL_API_KEY) return "mistral";
  return null;
}

function serverKeyForProvider(provider: APIProvider): string | undefined {
  switch (provider) {
    case "together":
      return nonEmpty(process.env.TOGETHER_API_KEY);
    case "openAI":
      return nonEmpty(process.env.OPENAI_API_KEY);
    case "anthropic":
      return nonEmpty(process.env.ANTHROPIC_API_KEY);
    case "google":
      return nonEmpty(process.env.GOOGLE_API_KEY);
    case "mistral":
      return nonEmpty(process.env.MISTRAL_API_KEY);
    case "auto":
      return (
        nonEmpty(process.env.TOGETHER_API_KEY) ??
        nonEmpty(process.env.OPENAI_API_KEY) ??
        nonEmpty(process.env.ANTHROPIC_API_KEY) ??
        nonEmpty(process.env.GOOGLE_API_KEY) ??
        nonEmpty(process.env.MISTRAL_API_KEY)
      );
  }
}

function resolveProviderAndKey(body: RequestBody): { provider: APIProvider; apiKey?: string; keySource: "client" | "server_env" } {
  const preference = body.providerPreference ?? "auto";
  const clientKey = nonEmpty(normalizeApiKeyInput(body.apiKey ?? ""));

  if (clientKey) {
    const clientProvider = preference === "auto" ? resolveProvider("auto", clientKey) : preference;
    return { provider: clientProvider, apiKey: clientKey, keySource: "client" };
  }

  if (preference === "auto") {
    const envProvider = providerFromServerEnv() ?? "together";
    return { provider: envProvider, apiKey: serverKeyForProvider(envProvider), keySource: "server_env" };
  }

  return { provider: preference, apiKey: serverKeyForProvider(preference), keySource: "server_env" };
}

async function postJson(url: string, init: RequestInit): Promise<unknown> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
        cache: "no-store"
      });

      const text = await response.text();
      let payload: unknown = {};
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = { raw: text };
        }
      }

      if (response.ok) {
        return payload;
      }

      const httpError = new HTTPStatusError(response.status, payload);
      lastError = httpError;

      const retryable = RETRYABLE_HTTP_STATUSES.has(response.status);
      if (!retryable || attempt >= MAX_RETRY_ATTEMPTS) {
        throw httpError;
      }

      const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
      await sleep(retryAfterMs ?? retryDelayMs(attempt));
    } catch (error) {
      lastError = error;
      const retryableError = isAbortError(error) || isNetworkError(error);
      if (!retryableError || attempt >= MAX_RETRY_ATTEMPTS) {
        throw error;
      }
      await sleep(retryDelayMs(attempt));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Provider request failed after retries.");
}

export async function POST(request: NextRequest) {
  let resolvedProvider: APIProvider | null = null;
  let resolvedKeySource: "client" | "server_env" | null = null;

  try {
    const body = (await request.json()) as RequestBody;
    const prompt = nonEmpty(body.prompt);
    if (!prompt) {
      return NextResponse.json({ error: "Prompt is required." }, { status: 400 });
    }

    const { provider, apiKey, keySource } = resolveProviderAndKey(body);
    resolvedProvider = provider;
    resolvedKeySource = keySource;
    if (!apiKey) {
      return NextResponse.json(
        { error: "No API key available. Provide one in UI or set server env vars." },
        { status: 400 }
      );
    }

    const model = nonEmpty(body.model) ?? defaultModelForProvider(provider);
    const systemPrompt = body.systemPrompt ?? "You are a helpful assistant.";
    const temperature = Number.isFinite(body.temperature) ? Number(body.temperature) : 0.7;
    const maxTokens = Number.isFinite(body.maxTokens) ? Number(body.maxTokens) : 512;

    let content = "";

    if (provider === "together") {
      const requestTogether = async (keyToUse: string) =>
        postJson("https://api.together.xyz/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${keyToUse}`
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: prompt }
            ],
            temperature,
            max_tokens: maxTokens,
            stream: false
          })
        });

      const serverTogetherKey = nonEmpty(process.env.TOGETHER_API_KEY);
      let payload: unknown;
      try {
        payload = await requestTogether(apiKey);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const shouldFallbackToServerKey =
          resolvedKeySource === "client" &&
          Boolean(serverTogetherKey) &&
          serverTogetherKey !== apiKey &&
          message.includes("invalid_api_key");

        if (!shouldFallbackToServerKey) {
          throw error;
        }

        payload = await requestTogether(serverTogetherKey as string);
        resolvedKeySource = "server_env";
      }

      content = (payload as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content ?? "";
    } else if (provider === "openAI") {
      const openAIOrganization = nonEmpty(process.env.OPENAI_ORGANIZATION);
      const openAIProject = nonEmpty(process.env.OPENAI_PROJECT);
      const requestOpenAI = async (keyToUse: string, includeEnvRoutingHeaders: boolean) =>
        postJson("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${keyToUse}`,
            ...(includeEnvRoutingHeaders && openAIOrganization ? { "OpenAI-Organization": openAIOrganization } : {}),
            ...(includeEnvRoutingHeaders && openAIProject ? { "OpenAI-Project": openAIProject } : {})
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: prompt }
            ],
            temperature,
            max_tokens: maxTokens
          })
        });

      const serverOpenAIKey = nonEmpty(process.env.OPENAI_API_KEY);
      let payload: unknown;
      try {
        payload = await requestOpenAI(apiKey, resolvedKeySource === "server_env");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const shouldFallbackToServerKey =
          resolvedKeySource === "client" &&
          Boolean(serverOpenAIKey) &&
          serverOpenAIKey !== apiKey &&
          message.includes("invalid_api_key");

        if (!shouldFallbackToServerKey) {
          throw error;
        }

        payload = await requestOpenAI(serverOpenAIKey as string, true);
        resolvedKeySource = "server_env";
      }

      content = (payload as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content ?? "";
    } else if (provider === "anthropic") {
      const payload = await postJson("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          temperature,
          system: systemPrompt,
          messages: [{ role: "user", content: prompt }]
        })
      });

      const blocks = (payload as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
      content = blocks.map((item) => item.text ?? "").join("");
    } else if (provider === "google") {
      const encodedModel = encodeURIComponent(model);
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodedModel}:generateContent?key=${apiKey}`;
      const payload = await postJson(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: `System: ${systemPrompt}\n\nUser: ${prompt}` }]
            }
          ],
          generationConfig: {
            temperature,
            maxOutputTokens: maxTokens
          }
        })
      });

      const candidates = (payload as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }).candidates ?? [];
      content = candidates
        .flatMap((candidate) => candidate.content?.parts ?? [])
        .map((part) => part.text ?? "")
        .join("");
    } else if (provider === "mistral") {
      const payload = await postJson("https://api.mistral.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: prompt }
          ],
          temperature,
          max_tokens: maxTokens
        })
      });

      content = (payload as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content ?? "";
    } else {
      return NextResponse.json({ error: "Provider resolution failed." }, { status: 400 });
    }

    return NextResponse.json({
      content,
      provider,
      keySource: resolvedKeySource,
      detectedProviderFromKey: body.apiKey ? detectKeyProvider(normalizeApiKeyInput(body.apiKey)) : null,
      model
    });
  } catch (error) {
    let message = error instanceof Error ? error.message : "Unknown error";
    const httpStatus = error instanceof HTTPStatusError ? error.status : null;
    const isTogetherInvalidKey =
      resolvedProvider === "together" && typeof message === "string" && message.includes("invalid_api_key");
    const isOpenAIInvalidKey =
      resolvedProvider === "openAI" && typeof message === "string" && message.includes("invalid_api_key");
    const isTransientProviderFailure =
      httpStatus !== null && RETRYABLE_HTTP_STATUSES.has(httpStatus) && !isTogetherInvalidKey && !isOpenAIInvalidKey;

    if (isTransientProviderFailure) {
      message +=
        " Tip: provider returned a transient server/rate-limit error after retries; this is usually not a credit depletion signal. Retry run, reduce request burst, or switch provider/model.";
    }
    if (isTogetherInvalidKey && resolvedKeySource === "client") {
      if (nonEmpty(process.env.TOGETHER_API_KEY)) {
        message += " Tip: clear the UI API Key field to use server TOGETHER_API_KEY, or paste the exact same key configured in Vercel.";
      } else {
        message += " Tip: the Together key entered in UI is invalid/revoked. Paste a valid Together key or configure TOGETHER_API_KEY in Vercel.";
      }
    }
    if (isOpenAIInvalidKey && resolvedKeySource === "client") {
      if (nonEmpty(process.env.OPENAI_API_KEY)) {
        message += " Tip: clear the UI API Key field to use server OPENAI_API_KEY, or paste the exact same key you validated in terminal.";
      } else {
        message +=
          " Tip: the OpenAI key entered in UI is invalid/revoked for this request context. Use a Platform key from https://platform.openai.com/api-keys or configure OPENAI_API_KEY in Vercel. If key works locally but fails on Vercel, check OpenAI project/org settings and any IP allowlist.";
      }
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
