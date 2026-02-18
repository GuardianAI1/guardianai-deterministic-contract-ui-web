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

function nonEmpty(value?: string): string | undefined {
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0 ? trimmed : undefined;
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      cache: "no-store"
    });

    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${JSON.stringify(payload)}`);
    }

    return payload;
  } finally {
    clearTimeout(timeout);
  }
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
      const requestOpenAI = async (keyToUse: string) =>
        postJson("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${keyToUse}`,
            ...(openAIOrganization ? { "OpenAI-Organization": openAIOrganization } : {}),
            ...(openAIProject ? { "OpenAI-Project": openAIProject } : {})
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
        payload = await requestOpenAI(apiKey);
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

        payload = await requestOpenAI(serverOpenAIKey as string);
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
    const isTogetherInvalidKey =
      resolvedProvider === "together" && typeof message === "string" && message.includes("invalid_api_key");
    const isOpenAIInvalidKey =
      resolvedProvider === "openAI" && typeof message === "string" && message.includes("invalid_api_key");
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
