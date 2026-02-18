import type { APIProvider } from "@/lib/types";

export const providerOptions: Array<{ value: APIProvider; label: string }> = [
  { value: "together", label: "Together" },
  { value: "openAI", label: "OpenAI" },
  { value: "anthropic", label: "Claude (Anthropic)" },
  { value: "google", label: "Google" },
  { value: "mistral", label: "Mistral" },
  { value: "auto", label: "Auto Detect" }
];

export function normalizeApiKeyInput(rawValue: string): string {
  let value = (rawValue ?? "").trim();
  if (!value) return "";

  const assignmentMatch = value.match(
    /^(?:export\s+)?(?:OPENAI_API_KEY|TOGETHER_API_KEY|ANTHROPIC_API_KEY|GOOGLE_API_KEY|MISTRAL_API_KEY)\s*=\s*(.+)$/i
  );
  if (assignmentMatch) {
    value = assignmentMatch[1].trim();
  }

  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim();
  }

  // Normalize and strip all separators/control chars (incl. zero-width and hidden Unicode)
  // to avoid clipboard/manager contamination in API key fields.
  return value.normalize("NFKC").replace(/[\p{Z}\p{C}]+/gu, "");
}

export function detectKeyProvider(apiKey: string): APIProvider | null {
  const trimmed = normalizeApiKeyInput(apiKey);
  if (!trimmed) return null;

  const lower = trimmed.toLowerCase();
  if (lower.startsWith("tgp_") || lower.startsWith("tgai_") || lower.startsWith("together_")) return "together";
  if (lower.startsWith("sk-ant-")) return "anthropic";
  if (trimmed.startsWith("AIza")) return "google";
  if (lower.startsWith("mistral-") || lower.startsWith("mistral_")) return "mistral";
  if (lower.startsWith("sk-")) return "openAI";
  return null;
}

export function resolveProvider(preference: APIProvider, apiKey: string): APIProvider {
  if (preference !== "auto") return preference;
  return detectKeyProvider(apiKey) ?? "together";
}

export function defaultModelForProvider(provider: APIProvider): string {
  switch (provider) {
    case "together":
    case "auto":
      return "google/gemma-3n-e4b-it";
    case "openAI":
      return "gpt-4o-mini";
    case "anthropic":
      return "claude-3-5-haiku-latest";
    case "google":
      return "gemini-1.5-flash";
    case "mistral":
      return "mistral-small-latest";
  }
}
