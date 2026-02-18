"use client";

import Image from "next/image";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  classifyMismatchKind,
  mismatchKindForTurn,
  percentageString,
  safeRate,
  type DeterministicMismatchKind
} from "@/lib/deterministic";
import { deterministicReadmeText, guardianSpecText } from "@/lib/docs";
import {
  defaultModelForProvider,
  detectKeyProvider,
  normalizeApiKeyInput,
  providerOptions,
  resolveProvider
} from "@/lib/providers";
import { adversarialScripts, promptCountOptions, scriptLabels } from "@/lib/scripts";
import type {
  APIProvider,
  BrutalTaxonomy,
  CoreTelemetry,
  ExecutionMode,
  ExperimentTurn,
  ExportSnapshot,
  GateState,
  ScriptPrompt
} from "@/lib/types";

const ASSISTED_RETRY_CAP_OPTIONS = [1, 2] as const;
const DEFAULT_SCRIPT_ID = "online_gsm8k_exact_answer_contract.jsonl";
const BRUTAL_SCRIPT_ID = "json_contract_brutal_v2";
const BRUTAL_ALLOWED_LABELS = ["A", "B", "C", "D"] as const;
const BRUTAL_OUTPUT_PATTERN = /^\{"result":\{"answer":"([ABCD])","confidence":0\.75\},"meta":\{"version":1\}\}$/;
const BRUTAL_SYSTEM_PROMPT =
  "You are a deterministic JSON output engine. Return exactly one compact JSON object under strict key order and schema.";
const BRUTAL_MAX_TOKENS_CAP = 48;

const CONTROL_LABELS: Record<GateState, { tone: "good" | "warn" | "bad"; label: string }> = {
  CONTINUE: { tone: "good", label: "CONTINUE" },
  PAUSE: { tone: "warn", label: "PAUSE" },
  YIELD: { tone: "warn", label: "YIELD" }
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildBrutalPrompt(expectedLabel: string, expectedLiteral: string): string {
  return [
    "You must output EXACTLY one JSON object.",
    "No markdown.",
    "No explanation.",
    "No additional text.",
    "No leading or trailing whitespace.",
    "No newline before or after the object.",
    "No spaces anywhere in the output.",
    "",
    "Schema:",
    '{"result":{"answer":"X","confidence":0.75},"meta":{"version":1}}',
    "",
    'Where X must be exactly one of: "A","B","C","D"',
    "Key order rules:",
    "1) Top-level keys must be exactly: result, then meta",
    "2) result keys must be exactly: answer, then confidence",
    "3) meta keys must be exactly: version",
    "4) No extra keys and no nested extras",
    "",
    "Return ONLY the JSON object.",
    "Replace X with the correct expected label.",
    `Expected label: ${expectedLabel}`,
    "",
    `The only valid output for this turn is exactly: ${expectedLiteral}`,
    `Exact character count must be: ${expectedLiteral.length}`,
    "First character must be '{' and last character must be '}'."
  ].join("\n");
}

function generateBrutalPrompts(repetitionCount: number): ScriptPrompt[] {
  const count = Math.max(4, Math.min(10_000, Math.floor(repetitionCount)));
  const prompts: ScriptPrompt[] = [];
  for (let index = 0; index < count; index += 1) {
    const expectedLabel = BRUTAL_ALLOWED_LABELS[index % BRUTAL_ALLOWED_LABELS.length];
    const expectedLiteral = `{"result":{"answer":"${expectedLabel}","confidence":0.75},"meta":{"version":1}}`;
    prompts.push({
      id: index + 1,
      prompt: buildBrutalPrompt(expectedLabel, expectedLiteral),
      category: BRUTAL_SCRIPT_ID,
      expected_behavior: "Return one compact nested JSON object only under strict deterministic contract.",
      expected_literal: expectedLiteral,
      expected_label: expectedLabel
    });
  }
  return prompts;
}

type BrutalEvaluation = {
  taxonomy: BrutalTaxonomy;
  rawMatch: boolean;
  jsonParseValid: boolean;
  schemaValid: boolean;
  keyOrderValid: boolean;
  semanticHardFailure: boolean;
  parsedLabel?: string;
};

function evaluateBrutalOutput(modelOutput: string, expectedLabel: string, expectedLiteral: string): BrutalEvaluation {
  const rawMatch = modelOutput === expectedLiteral;
  if (rawMatch) {
    return {
      taxonomy: "EXACT_MATCH",
      rawMatch: true,
      jsonParseValid: true,
      schemaValid: true,
      keyOrderValid: true,
      semanticHardFailure: false,
      parsedLabel: expectedLabel
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(modelOutput);
  } catch {
    return {
      taxonomy: "NON_JSON_OUTPUT",
      rawMatch: false,
      jsonParseValid: false,
      schemaValid: false,
      keyOrderValid: false,
      semanticHardFailure: false
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      taxonomy: "SCHEMA_VIOLATION",
      rawMatch: false,
      jsonParseValid: true,
      schemaValid: false,
      keyOrderValid: false,
      semanticHardFailure: false
    };
  }

  const record = parsed as Record<string, unknown>;
  const topKeys = Object.keys(record);
  const topLevelKeyOrderValid = topKeys.length === 2 && topKeys[0] === "result" && topKeys[1] === "meta";

  const resultValue = record.result;
  const metaValue = record.meta;

  const resultIsObject = Boolean(resultValue) && typeof resultValue === "object" && !Array.isArray(resultValue);
  const metaIsObject = Boolean(metaValue) && typeof metaValue === "object" && !Array.isArray(metaValue);

  const resultRecord = resultIsObject ? (resultValue as Record<string, unknown>) : null;
  const metaRecord = metaIsObject ? (metaValue as Record<string, unknown>) : null;

  const resultKeys = resultRecord ? Object.keys(resultRecord) : [];
  const metaKeys = metaRecord ? Object.keys(metaRecord) : [];
  const resultKeyOrderValid = resultKeys.length === 2 && resultKeys[0] === "answer" && resultKeys[1] === "confidence";
  const metaKeyOrderValid = metaKeys.length === 1 && metaKeys[0] === "version";

  const answerValue = resultRecord?.answer;
  const confidenceValue = resultRecord?.confidence;
  const versionValue = metaRecord?.version;

  const keyOrderValid = topLevelKeyOrderValid && resultKeyOrderValid && metaKeyOrderValid;
  const schemaValid =
    topLevelKeyOrderValid &&
    resultIsObject &&
    metaIsObject &&
    resultKeyOrderValid &&
    metaKeyOrderValid &&
    typeof answerValue === "string" &&
    BRUTAL_ALLOWED_LABELS.includes(answerValue as (typeof BRUTAL_ALLOWED_LABELS)[number]) &&
    typeof confidenceValue === "number" &&
    confidenceValue === 0.75 &&
    typeof versionValue === "number" &&
    versionValue === 1;

  if (!schemaValid) {
    return {
      taxonomy: "SCHEMA_VIOLATION",
      rawMatch: false,
      jsonParseValid: true,
      schemaValid: false,
      keyOrderValid,
      semanticHardFailure: false
    };
  }

  const semanticHardFailure = answerValue !== expectedLabel;
  if (semanticHardFailure) {
    return {
      taxonomy: "SEMANTIC_HARD_FAILURE",
      rawMatch: false,
      jsonParseValid: true,
      schemaValid: true,
      keyOrderValid,
      semanticHardFailure: true,
      parsedLabel: answerValue as string
    };
  }

  return {
    taxonomy: "FORMAT_ONLY_DRIFT",
    rawMatch: false,
    jsonParseValid: true,
    schemaValid: true,
    keyOrderValid,
    semanticHardFailure: false,
    parsedLabel: answerValue as string
  };
}

function statusTone(state: "on" | "off" | "neutral"): "good" | "bad" | "warn" {
  if (state === "on") return "good";
  if (state === "off") return "bad";
  return "warn";
}

function normalizeExpectedLiteral(prompt: ScriptPrompt): string | undefined {
  const candidate = prompt.expected_literal;
  if (typeof candidate !== "string") return undefined;
  const trimmed = candidate.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function turnProgressLabel(turnIndex: number, loadedPromptCount: number, turnCount: number, turns: ExperimentTurn[]): string {
  const total = loadedPromptCount > 0 ? loadedPromptCount : turnCount > 0 ? turnCount : Math.max(0, ...turns.map((turn) => turn.turnIndex));
  return `${turnIndex}/${Math.max(total, turnIndex)}`;
}

function toMismatchLabel(kind: DeterministicMismatchKind | null): string {
  if (!kind) return "N/A";
  if (kind === "exact") return "ALIGNED";
  if (kind === "formattingOnly") return "FORMAT DRIFT";
  return "HARD FAILURE";
}

function toBrutalTaxonomyLabel(taxonomy?: BrutalTaxonomy): string {
  if (!taxonomy) return "N/A";
  if (taxonomy === "EXACT_MATCH") return "EXACT MATCH";
  if (taxonomy === "FORMAT_ONLY_DRIFT") return "FORMAT ONLY DRIFT";
  if (taxonomy === "SCHEMA_VIOLATION") return "SCHEMA VIOLATION";
  if (taxonomy === "SEMANTIC_HARD_FAILURE") return "SEMANTIC HARD FAILURE";
  return "NON-JSON OUTPUT";
}

function boolLabel(value?: boolean): string {
  if (value === undefined) return "N/A";
  return value ? "YES" : "NO";
}

function confidenceInterval95(rate: number | null, trials: number): string {
  if (rate === null || trials <= 0) return "n/a";

  const z = 1.96;
  const variance = (rate * (1 - rate)) / trials;
  const margin = z * Math.sqrt(variance);
  const low = Math.max(0, rate - margin);
  const high = Math.min(1, rate + margin);

  return `[${(low * 100).toFixed(1)}%, ${(high * 100).toFixed(1)}%]`;
}

function extractPromptDeclaredLiteral(prompt: string): string | null {
  const markerMatch = prompt.match(/Output exactly this final literal and nothing else:\s*([^\n]+)/i);
  if (!markerMatch) return null;

  let value = markerMatch[1].trim();
  const stopMarkers = [
    " Problem:",
    " Question:",
    " Context:",
    " Passage:",
    " Allowed tokens:",
    " Use option label",
    " Use one digit",
    " Choices:"
  ];

  for (const marker of stopMarkers) {
    const index = value.indexOf(marker);
    if (index >= 0) {
      value = value.slice(0, index).trim();
    }
  }

  return value.length > 0 ? value : null;
}

function buildAssistedConstraintPrompt(turn: ExperimentTurn): string {
  return `You are the GuardianAI assisted constraint proposer.

Hard requirements:
- Output only deterministic contract-enforcement rules for the next response.
- Do not auto-continue on PAUSE without explicit operator override.
- Do not override, suppress, or reinterpret the PAUSE gate.
- Do not rewrite or alter any past output.
- Keep constraints minimal, operational, and testable.
- Force byte-exact compliance with the expected literal when present.
- Return plain text only, max 8 bullet points.

Turn ${turn.turnIndex} prompt:
${turn.prompt}

Turn ${turn.turnIndex} baseline output:
${turn.baselineOutput}

Expected literal:
${turn.contractExpectedLiteral ?? "n/a"}

Contract exact match:
${turn.contractExactMatch === undefined ? "n/a" : String(turn.contractExactMatch)}

Provide the minimal externalizable constraint set now.`;
}

async function requestJSON<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    cache: "no-store"
  });

  const text = await response.text();
  let payload: Record<string, unknown> = {};
  if (text) {
    try {
      payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
      const looksLikeHtml = text.trimStart().startsWith("<!DOCTYPE");
      const moduleChunkError = text.includes("Cannot find module './");
      if (looksLikeHtml && moduleChunkError) {
        throw new Error("Dev server returned HTML error page (stale .next cache). Stop dev server, delete .next, then run npm run dev.");
      }
      if (looksLikeHtml) {
        throw new Error("Server returned HTML instead of JSON. Check terminal logs and restart the dev server.");
      }
      throw new Error("Server returned invalid JSON.");
    }
  }

  if (!response.ok) {
    const message = (payload as { error?: string }).error ?? `HTTP ${response.status}`;
    throw new Error(message);
  }

  return payload as T;
}

async function loadScriptPrompts(scriptFileName: string): Promise<ScriptPrompt[]> {
  const response = await fetch(`/scripts/${scriptFileName}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Unable to load script ${scriptFileName}`);

  const text = await response.text();
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const prompts: ScriptPrompt[] = [];
  for (const line of lines) {
    prompts.push(JSON.parse(line) as ScriptPrompt);
  }

  return prompts;
}

function downloadTextFile(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function SectionDocModal({ title, body, onClose }: { title: string; body: string; onClose: () => void }) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal-sheet">
        <div className="modal-head">
          <h2>{title}</h2>
          <button onClick={onClose}>Close</button>
        </div>
        <pre className="doc-block">{body}</pre>
      </div>
    </div>
  );
}

function PauseModal({
  busy,
  onContinue,
  onStop,
  onCancel
}: {
  busy: boolean;
  onContinue: () => void;
  onStop: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="pause-sheet">
        <h2>DETERMINISTIC PAUSE</h2>
        <p>Strict contract guard paused this turn.</p>
        <div className="row-actions">
          <button onClick={onContinue} disabled={busy}>
            Continue With Override
          </button>
          <button onClick={onStop} disabled={busy} className="danger">
            Stop Experiment
          </button>
          <button onClick={onCancel} disabled={busy} className="ghost">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

export default function HomePage() {
  const [selectedScript, setSelectedScript] = useState<string>(
    adversarialScripts.includes(DEFAULT_SCRIPT_ID) ? DEFAULT_SCRIPT_ID : adversarialScripts[0]
  );
  const [selectedSize, setSelectedSize] = useState<number>(0);
  const [apiProvider, setApiProvider] = useState<APIProvider>("together");
  const [apiKey, setApiKey] = useState<string>("");
  const [llmTemperature, setLlmTemperature] = useState<number>(0);
  const [guardianTemperature, setGuardianTemperature] = useState<number>(0);
  const [llmMaxTokens, setLlmMaxTokens] = useState<number>(64);
  const [executionMode, setExecutionMode] = useState<ExecutionMode>("passive");
  const [assistedRetryCap, setAssistedRetryCap] = useState<number>(2);
  const [brutalRepetitionCount, setBrutalRepetitionCount] = useState<number>(100);

  const [turns, setTurns] = useState<ExperimentTurn[]>([]);
  const [loadedPrompts, setLoadedPrompts] = useState<ScriptPrompt[]>([]);

  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [guardianCloudConnected, setGuardianCloudConnected] = useState<boolean>(false);

  const [turnCount, setTurnCount] = useState<number>(0);
  const [pauseCount, setPauseCount] = useState<number>(0);
  const [overrideCount, setOverrideCount] = useState<number>(0);
  const [constraintCount, setConstraintCount] = useState<number>(0);

  const [isGeneratingLabReport, setIsGeneratingLabReport] = useState<boolean>(false);
  const [showReadme, setShowReadme] = useState<boolean>(false);
  const [showSpec, setShowSpec] = useState<boolean>(false);
  const [showPauseModal, setShowPauseModal] = useState<boolean>(false);

  const runControlRef = useRef<{ cancelled: boolean }>({ cancelled: false });
  const apiKeyInputRef = useRef<HTMLInputElement | null>(null);

  function setNormalizedApiKey(rawValue: string) {
    setApiKey(normalizeApiKeyInput(rawValue));
  }

  const guardianEnabled = true;
  const assistedEnabled = executionMode === "assisted";
  const executionModeLabel = assistedEnabled ? "Assisted (Guardian Retry)" : "Passive (Default)";
  const guardianDetectionMode = "Contract Enforcement";
  const contractComparatorMode = "Raw Byte-Exact";
  const pausePolicy = assistedEnabled ? `Guardian Retry (max ${assistedRetryCap})` : "Passive baseline (no retries)";

  const websiteURL = process.env.NEXT_PUBLIC_GUARDIAN_WEBSITE_URL?.trim() || "";
  const githubURL = process.env.NEXT_PUBLIC_GITHUB_REPO_URL?.trim() || "";
  const isBrutalScript = selectedScript === BRUTAL_SCRIPT_ID;

  const detectedKeyProvider = useMemo(() => detectKeyProvider(apiKey), [apiKey]);
  const effectiveProvider = useMemo(() => resolveProvider(apiProvider, apiKey), [apiProvider, apiKey]);
  const effectiveModel = useMemo(() => defaultModelForProvider(effectiveProvider), [effectiveProvider]);

  const deterministicTurns = useMemo(
    () => turns.filter((turn) => turn.contractExactMatch !== undefined && turn.contractExactMatch !== null),
    [turns]
  );

  const deterministicTrialCount = deterministicTurns.length;
  const deterministicExactMatchCount = deterministicTurns.filter((turn) => turn.contractExactMatch).length;
  const deterministicViolationCount = deterministicTrialCount - deterministicExactMatchCount;
  const deterministicViolationRate = safeRate(deterministicViolationCount, deterministicTrialCount);

  const deterministicTrimmedSemanticMismatchCount = useMemo(
    () => deterministicTurns.filter((turn) => mismatchKindForTurn(turn) === "semanticHardFailure").length,
    [deterministicTurns]
  );
  const deterministicTrimmedSemanticMismatchRate = safeRate(
    deterministicTrimmedSemanticMismatchCount,
    deterministicTrialCount
  );

  const deterministicFormatOnlyMismatchCount = useMemo(
    () => deterministicTurns.filter((turn) => mismatchKindForTurn(turn) === "formattingOnly").length,
    [deterministicTurns]
  );
  const deterministicFormatOnlyMismatchRate = safeRate(deterministicFormatOnlyMismatchCount, deterministicTrialCount);

  const brutalTurns = useMemo(() => turns.filter((turn) => turn.taxonomy !== undefined), [turns]);
  const brutalTrialCount = brutalTurns.length;
  const brutalExactMatchCount = useMemo(
    () => brutalTurns.filter((turn) => turn.taxonomy === "EXACT_MATCH").length,
    [brutalTurns]
  );
  const brutalFormatOnlyMismatchCount = useMemo(
    () => brutalTurns.filter((turn) => turn.taxonomy === "FORMAT_ONLY_DRIFT").length,
    [brutalTurns]
  );
  const brutalSchemaViolationCount = useMemo(
    () => brutalTurns.filter((turn) => turn.taxonomy === "SCHEMA_VIOLATION").length,
    [brutalTurns]
  );
  const brutalSemanticHardFailureCount = useMemo(
    () => brutalTurns.filter((turn) => turn.taxonomy === "SEMANTIC_HARD_FAILURE").length,
    [brutalTurns]
  );
  const brutalNonJsonOutputCount = useMemo(
    () => brutalTurns.filter((turn) => turn.taxonomy === "NON_JSON_OUTPUT").length,
    [brutalTurns]
  );
  const brutalRawByteMismatchCount = brutalTrialCount - brutalExactMatchCount;
  const brutalRawByteMismatchRate = safeRate(brutalRawByteMismatchCount, brutalTrialCount);
  const brutalFormatOnlyMismatchRate = safeRate(brutalFormatOnlyMismatchCount, brutalTrialCount);
  const brutalSchemaViolationRate = safeRate(brutalSchemaViolationCount, brutalTrialCount);
  const brutalSemanticHardFailureRate = safeRate(brutalSemanticHardFailureCount, brutalTrialCount);
  const brutalExactMatchRate = safeRate(brutalExactMatchCount, brutalTrialCount);
  const brutalNonJsonOutputRate = safeRate(brutalNonJsonOutputCount, brutalTrialCount);

  const initialEvaluatedTurns = useMemo(
    () => turns.filter((turn) => turn.initialExactMatch !== undefined && turn.initialExactMatch !== null),
    [turns]
  );
  const initialFailureCount = initialEvaluatedTurns.filter((turn) => turn.initialExactMatch === false).length;
  const initialFailureRate = safeRate(initialFailureCount, initialEvaluatedTurns.length);
  const baselineHardSemanticFailureCount = useMemo(
    () =>
      initialEvaluatedTurns.filter((turn) => {
        if (!turn.contractExpectedLiteral) return false;
        return (
          classifyMismatchKind(turn.contractExpectedLiteral, turn.initialOutput, Boolean(turn.initialExactMatch)) ===
          "semanticHardFailure"
        );
      }).length,
    [initialEvaluatedTurns]
  );
  const baselineHardSemanticFailureRate = safeRate(baselineHardSemanticFailureCount, initialEvaluatedTurns.length);
  const correctionSuccessCount = turns.filter((turn) => turn.initialExactMatch === false && turn.correctionSucceeded).length;
  const correctionSuccessRate = safeRate(correctionSuccessCount, initialFailureCount);
  const retryCountTotal = turns.reduce((sum, turn) => sum + turn.retryCountUsed, 0);
  const retryCountAverage = safeRate(retryCountTotal, turns.length);

  const latestTurn = turns.length > 0 ? turns[turns.length - 1] : null;
  const latestMismatchKind = latestTurn ? mismatchKindForTurn(latestTurn) : null;
  const latestPromptDeclaredLiteral = latestTurn ? extractPromptDeclaredLiteral(latestTurn.prompt) : null;
  const liveExpectedLiteral = latestTurn?.contractExpectedLiteral?.trim() || "[expected literal not available yet]";
  const liveOutputLiteral = latestTurn?.baselineOutput ?? "";
  const liveOutputLength = liveOutputLiteral.length;
  const liveExpectedLength = latestTurn?.contractExpectedLiteral?.length ?? null;
  const liveOutputBytes = new TextEncoder().encode(liveOutputLiteral);
  const liveOutputEscapedLiteral = liveOutputLiteral ? JSON.stringify(liveOutputLiteral) : "[no output yet]";
  const liveLengthExact = liveExpectedLength === null ? null : liveOutputLength === liveExpectedLength;
  const liveTrailingWhitespace = /\s$/u.test(liveOutputLiteral);
  const liveLeadingWhitespace = /^\s/u.test(liveOutputLiteral);
  const liveOutputByteVector =
    liveOutputBytes.length > 0
      ? `[${Array.from(liveOutputBytes.slice(0, 120)).join(", ")}${liveOutputBytes.length > 120 ? ", ..." : ""}]`
      : "[]";
  const latestExactMatchLabel =
    latestTurn?.contractExactMatch === undefined ? "N/A" : latestTurn.contractExactMatch ? "YES" : "NO";
  const latestInitialExactMatchLabel =
    latestTurn?.initialExactMatch === undefined ? "N/A" : latestTurn.initialExactMatch ? "YES" : "NO";
  const latestPromptAlignedMatch =
    latestTurn && latestPromptDeclaredLiteral
      ? latestTurn.baselineOutput.trim() === latestPromptDeclaredLiteral.trim()
      : null;
  const latestPromptAlignedLabel =
    latestPromptAlignedMatch === null ? "N/A" : latestPromptAlignedMatch ? "YES" : "NO";
  const latestComplianceLabel =
    isBrutalScript
      ? latestTurn?.taxonomy === undefined
        ? "N/A"
        : latestTurn.taxonomy === "EXACT_MATCH"
          ? "Exact match"
          : "Contract breach"
      : latestTurn?.contractExactMatch === undefined || latestTurn?.contractExactMatch === null
        ? "N/A"
        : latestTurn.contractExactMatch
          ? "Exact match"
          : latestPromptAlignedMatch
            ? "Strict mismatch (prompt-aligned)"
            : "Literal mismatch";
  const latestLiteralSourceDiff =
    latestTurn?.contractExpectedLiteral && latestPromptDeclaredLiteral
      ? latestTurn.contractExpectedLiteral.trim() !== latestPromptDeclaredLiteral.trim()
      : false;
  const latestGateLabel = latestTurn?.gateState ?? "N/A";
  const latestSemanticClassLabel = latestMismatchKind ? toMismatchLabel(latestMismatchKind) : "N/A";
  const latestTaxonomyLabel = toBrutalTaxonomyLabel(latestTurn?.taxonomy);
  const latestRawMatchLabel = boolLabel(latestTurn?.rawMatch);
  const latestJsonParseValidLabel = boolLabel(latestTurn?.jsonParseValid);
  const latestSchemaValidLabel = boolLabel(latestTurn?.schemaValid);
  const latestKeyOrderValidLabel = boolLabel(latestTurn?.keyOrderValid);
  const latestSemanticHardFailureLabel = boolLabel(latestTurn?.semanticHardFailure);

  const guardianStatusState = isBrutalScript ? (isRunning ? "on" : "neutral") : isRunning && guardianCloudConnected ? "on" : "neutral";
  const guardianStatusLabel = isBrutalScript ? (isRunning ? "LOCAL STRICT" : "LOCAL READY") : guardianStatusState === "on" ? "CONNECTED" : "IDLE";

  useEffect(() => {
    const syncKeyFromDom = () => {
      const domValue = apiKeyInputRef.current?.value;
      if (typeof domValue === "string") {
        const normalized = normalizeApiKeyInput(domValue);
        if (normalized !== apiKey) {
          setApiKey(normalized);
        }
      }
    };

    const timerA = window.setTimeout(syncKeyFromDom, 120);
    const timerB = window.setTimeout(syncKeyFromDom, 800);

    return () => {
      window.clearTimeout(timerA);
      window.clearTimeout(timerB);
    };
  }, [apiKey]);

  async function requestLLM(prompt: string, opts?: { maxTokens?: number; systemPrompt?: string; temperature?: number }) {
    const response = await requestJSON<{ content: string }>("/api/llm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: effectiveModel,
        prompt,
        apiKey,
        providerPreference: apiProvider,
        temperature: opts?.temperature ?? llmTemperature,
        maxTokens: opts?.maxTokens ?? llmMaxTokens,
        systemPrompt: opts?.systemPrompt
      })
    });

    return response.content ?? "";
  }

  async function observeOutput(
    turnId: number,
    output: string,
    expectedLiteral?: string
  ): Promise<{ gateState: GateState; telemetry?: CoreTelemetry }> {
    if (!guardianEnabled) {
      return { gateState: "CONTINUE", telemetry: undefined };
    }

    const observe = await requestJSON<{ gateState: GateState; telemetry: CoreTelemetry }>("/api/guardian/observe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        turnId,
        output,
        deterministicConstraint: expectedLiteral ?? null
      })
    });

    setGuardianCloudConnected(true);
    return { gateState: observe.gateState, telemetry: observe.telemetry };
  }

  async function applyAssistedConstraint(turn: ExperimentTurn) {
    const proposalPrompt = buildAssistedConstraintPrompt(turn);
    const proposal = await requestLLM(proposalPrompt, {
      maxTokens: 600,
      systemPrompt: "You produce minimal deterministic contract constraints.",
      temperature: guardianTemperature
    });

    const constraintText = proposal.trim().slice(0, 8000);
    if (!constraintText) {
      throw new Error("Assisted proposal returned empty constraint.");
    }

    await requestJSON<{ ok: boolean }>("/api/guardian/constraint", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: constraintText })
    });
  }

  function resetRunState() {
    setTurns([]);
    setTurnCount(0);
    setPauseCount(0);
    setOverrideCount(0);
    setConstraintCount(0);
    setGuardianCloudConnected(false);
    setShowPauseModal(false);
    setErrorMessage(null);
  }

  function stopExperiment() {
    runControlRef.current.cancelled = true;
    setIsRunning(false);
    setGuardianCloudConnected(false);
  }

  function resetExperiment() {
    stopExperiment();
    setLoadedPrompts([]);
    resetRunState();
  }

  async function startExperiment() {
    if (isRunning) return;

    setErrorMessage(null);
    resetRunState();

    let runPrompts: ScriptPrompt[] = [];
    if (selectedScript === BRUTAL_SCRIPT_ID) {
      runPrompts = generateBrutalPrompts(brutalRepetitionCount);
    } else {
      let prompts: ScriptPrompt[] = [];
      try {
        prompts = await loadScriptPrompts(selectedScript);
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : "Failed to load script.");
        return;
      }

      const limit = selectedSize === 0 ? prompts.length : Math.min(selectedSize, prompts.length);
      runPrompts = prompts.slice(0, limit);
    }

    setLoadedPrompts(runPrompts);
    setIsRunning(true);
    runControlRef.current.cancelled = false;

    let localTurns: ExperimentTurn[] = [];
    let localTurnCount = 0;
    let localPauseCount = 0;
    let localOverrideCount = 0;
    let localConstraintCount = 0;
    let abortRun = false;

    for (let index = 0; index < runPrompts.length; index += 1) {
      if (runControlRef.current.cancelled || abortRun) break;

      const scriptPrompt = runPrompts[index];
      const turnIndex = index + 1;
      const userPrompt = scriptPrompt.prompt;
      const expectedLiteral = normalizeExpectedLiteral(scriptPrompt);
      const expectedLabelHint = typeof scriptPrompt.expected_label === "string" ? scriptPrompt.expected_label.trim() : undefined;
      const expectedLabelFromLiteral = expectedLiteral ? expectedLiteral.match(BRUTAL_OUTPUT_PATTERN)?.[1] : undefined;
      const expectedLabel = expectedLabelHint ?? expectedLabelFromLiteral;
      const brutalRequestOptions = isBrutalScript
        ? {
            maxTokens: Math.min(llmMaxTokens, BRUTAL_MAX_TOKENS_CAP),
            systemPrompt: BRUTAL_SYSTEM_PROMPT
          }
        : undefined;

      let initialOutput = "";
      try {
        initialOutput = await requestLLM(userPrompt, brutalRequestOptions);
      } catch (error) {
        setErrorMessage(`LLM failure at turn ${turnIndex}: ${error instanceof Error ? error.message : "Unknown"}`);
        setIsRunning(false);
        setGuardianCloudConnected(false);
        abortRun = true;
        break;
      }

      const initialExactMatch = expectedLiteral !== undefined ? initialOutput === expectedLiteral : undefined;
      let initialGateState: GateState = "CONTINUE";
      let finalGateState: GateState = "CONTINUE";
      let telemetry: CoreTelemetry | undefined;
      let initialBrutalEvaluation: BrutalEvaluation | undefined;
      let finalBrutalEvaluation: BrutalEvaluation | undefined;

      if (isBrutalScript && expectedLiteral && expectedLabel) {
        initialBrutalEvaluation = evaluateBrutalOutput(initialOutput, expectedLabel, expectedLiteral);
        finalBrutalEvaluation = initialBrutalEvaluation;
        initialGateState = initialBrutalEvaluation.taxonomy === "EXACT_MATCH" ? "CONTINUE" : "PAUSE";
        finalGateState = initialGateState;
      } else {
        try {
          const observed = await observeOutput(turnIndex * 10, initialOutput, expectedLiteral);
          initialGateState = observed.gateState;
          finalGateState = observed.gateState;
          telemetry = observed.telemetry;
        } catch (error) {
          setErrorMessage(
            `GuardianAI observe/decide failed at turn ${turnIndex}: ${error instanceof Error ? error.message : "Unknown"}`
          );
          setIsRunning(false);
          setGuardianCloudConnected(false);
          abortRun = true;
          break;
        }
      }

      let finalOutput = initialOutput;
      let finalExactMatch = initialExactMatch;
      let retryCountUsed = 0;
      let correctionSucceeded = false;
      let constraintApplied = false;
      let constraintSource: ExperimentTurn["constraintSource"] | undefined = undefined;

      if (assistedEnabled && expectedLiteral !== undefined && initialExactMatch === false) {
        while (retryCountUsed < assistedRetryCap && finalExactMatch === false) {
          if (runControlRef.current.cancelled || abortRun) break;

          if (!isBrutalScript && finalGateState === "PAUSE") {
            const pauseTurn: ExperimentTurn = {
              id: `assist-${turnIndex}-${retryCountUsed + 1}`,
              turnIndex,
              prompt: userPrompt,
              initialOutput,
              baselineOutput: finalOutput,
              initialGateState,
              gateState: finalGateState,
              telemetry,
              initialExactMatch,
              overrideApplied: false,
              constraintApplied,
              overrideWithoutGrounding: false,
              constraintSource,
              contractExpectedLiteral: expectedLiteral,
              contractExactMatch: finalExactMatch,
              expectedLabel,
              retryCountUsed,
              correctionSucceeded,
              rawMatch: finalBrutalEvaluation?.rawMatch,
              jsonParseValid: finalBrutalEvaluation?.jsonParseValid,
              schemaValid: finalBrutalEvaluation?.schemaValid,
              keyOrderValid: finalBrutalEvaluation?.keyOrderValid,
              semanticHardFailure: finalBrutalEvaluation?.semanticHardFailure,
              taxonomy: finalBrutalEvaluation?.taxonomy
            };

            try {
              await applyAssistedConstraint(pauseTurn);
              constraintApplied = true;
              constraintSource = "Assisted Constraint Proposal";
              localConstraintCount += 1;
              setConstraintCount(localConstraintCount);
            } catch (error) {
              setErrorMessage(
                `Constraint submission failed at turn ${turnIndex}: ${error instanceof Error ? error.message : "Unknown"}`
              );
              setIsRunning(false);
              setGuardianCloudConnected(false);
              abortRun = true;
              break;
            }
          }

          retryCountUsed += 1;

          let retryOutput = "";
          try {
            retryOutput = await requestLLM(userPrompt, brutalRequestOptions);
          } catch (error) {
            setErrorMessage(`LLM retry failure at turn ${turnIndex}: ${error instanceof Error ? error.message : "Unknown"}`);
            setIsRunning(false);
            setGuardianCloudConnected(false);
            abortRun = true;
            break;
          }

          finalOutput = retryOutput;
          finalExactMatch = retryOutput === expectedLiteral;

          if (isBrutalScript && expectedLiteral && expectedLabel) {
            finalBrutalEvaluation = evaluateBrutalOutput(retryOutput, expectedLabel, expectedLiteral);
            finalGateState = finalBrutalEvaluation.taxonomy === "EXACT_MATCH" ? "CONTINUE" : "PAUSE";
          } else {
            try {
              const observedRetry = await observeOutput(turnIndex * 10 + retryCountUsed, retryOutput, expectedLiteral);
              finalGateState = observedRetry.gateState;
              telemetry = observedRetry.telemetry;
            } catch (error) {
              setErrorMessage(
                `GuardianAI observe/decide failed at retry ${retryCountUsed} for turn ${turnIndex}: ${error instanceof Error ? error.message : "Unknown"}`
              );
              setIsRunning(false);
              setGuardianCloudConnected(false);
              abortRun = true;
              break;
            }
          }
        }

        correctionSucceeded = finalExactMatch === true && retryCountUsed > 0;
      }

      if (abortRun) break;

      if (finalGateState === "PAUSE") {
        localPauseCount += 1;
        setPauseCount(localPauseCount);
      }

      const newTurn: ExperimentTurn = {
        id: `${Date.now()}-${turnIndex}-${Math.random().toString(36).slice(2, 8)}`,
        turnIndex,
        prompt: userPrompt,
        initialOutput,
        baselineOutput: finalOutput,
        initialGateState,
        gateState: finalGateState,
        telemetry,
        initialExactMatch,
        overrideApplied: false,
        constraintApplied,
        overrideWithoutGrounding: false,
        constraintSource,
        contractExpectedLiteral: expectedLiteral,
        contractExactMatch: finalExactMatch,
        expectedLabel,
        retryCountUsed,
        correctionSucceeded,
        rawMatch: finalBrutalEvaluation?.rawMatch,
        jsonParseValid: finalBrutalEvaluation?.jsonParseValid,
        schemaValid: finalBrutalEvaluation?.schemaValid,
        keyOrderValid: finalBrutalEvaluation?.keyOrderValid,
        semanticHardFailure: finalBrutalEvaluation?.semanticHardFailure,
        taxonomy: finalBrutalEvaluation?.taxonomy
      };

      localTurns = [...localTurns, newTurn];
      localTurnCount += 1;
      setTurns(localTurns);
      setTurnCount(localTurnCount);

      if (runControlRef.current.cancelled) break;
      await sleep(2000);
    }

    setOverrideCount(localOverrideCount);
    setConstraintCount(localConstraintCount);
    setIsRunning(false);
    setGuardianCloudConnected(false);
  }

  function buildSnapshot(): ExportSnapshot {
    const snapshotRawByteMismatchCount = isBrutalScript ? brutalRawByteMismatchCount : deterministicViolationCount;
    const snapshotRawByteMismatchRate = isBrutalScript ? brutalRawByteMismatchRate : deterministicViolationRate;
    const snapshotFormatOnlyMismatchCount = isBrutalScript
      ? brutalFormatOnlyMismatchCount
      : deterministicFormatOnlyMismatchCount;
    const snapshotFormatOnlyMismatchRate = isBrutalScript ? brutalFormatOnlyMismatchRate : deterministicFormatOnlyMismatchRate;
    const snapshotSemanticMismatchCount = isBrutalScript
      ? brutalSemanticHardFailureCount
      : deterministicTrimmedSemanticMismatchCount;
    const snapshotSemanticMismatchRate = isBrutalScript
      ? brutalSemanticHardFailureRate
      : deterministicTrimmedSemanticMismatchRate;
    const snapshotBaselineSemanticCount = isBrutalScript
      ? brutalSemanticHardFailureCount
      : baselineHardSemanticFailureCount;
    const snapshotBaselineSemanticRate = isBrutalScript
      ? brutalSemanticHardFailureRate
      : baselineHardSemanticFailureRate;

    return {
      exportedAt: new Date().toISOString(),
      apiProvider,
      resolvedLLMProvider: effectiveProvider,
      selectedModel: effectiveModel,
      llmTemperature,
      guardianTemperature,
      llmMaxTokens,
      selectedScript,
      promptCount: isBrutalScript
        ? `${Math.max(4, Math.min(10_000, Math.floor(brutalRepetitionCount)))}`
        : promptCountOptions.find((item) => item.value === selectedSize)?.label ?? String(selectedSize),
      brutalRepetitionCount: isBrutalScript
        ? Math.max(4, Math.min(10_000, Math.floor(brutalRepetitionCount)))
        : undefined,
      executionMode: executionModeLabel,
      guardianDetectionMode,
      contractComparator: contractComparatorMode,
      pausePolicy,
      guardianEnabled,
      metrics: {
        turns: turnCount,
        pauses: pauseCount,
        retriesUsedTotal: retryCountTotal,
        retriesUsedAverage: retryCountAverage,
        initialFailureCount,
        initialFailureRate,
        correctionSuccessCount: assistedEnabled ? correctionSuccessCount : 0,
        correctionSuccessRate: assistedEnabled ? correctionSuccessRate : null,
        finalResidualFailureCount: snapshotRawByteMismatchCount,
        finalResidualFailureRate: snapshotRawByteMismatchRate,
        baselineHardSemanticFailureCount: snapshotBaselineSemanticCount,
        baselineHardSemanticFailureRate: snapshotBaselineSemanticRate,
        assistedRetryCap,
        assistedEnabled,
        overrides: overrideCount,
        constraints: constraintCount,
        observations: guardianEnabled ? turns.length : 0,
        rawByteMismatchCount: snapshotRawByteMismatchCount,
        rawByteMismatchRate: snapshotRawByteMismatchRate,
        trimmedSemanticMismatchCount: snapshotSemanticMismatchCount,
        trimmedSemanticMismatchRate: snapshotSemanticMismatchRate,
        formatOnlyMismatchCount: snapshotFormatOnlyMismatchCount,
        formatOnlyMismatchRate: snapshotFormatOnlyMismatchRate,
        schemaViolationRate: isBrutalScript ? brutalSchemaViolationRate : null,
        semanticHardFailureRate: isBrutalScript ? brutalSemanticHardFailureRate : null,
        exactMatchRate: isBrutalScript ? brutalExactMatchRate : null,
        nonJsonOutputRate: isBrutalScript ? brutalNonJsonOutputRate : null,
        primarySafetyMetric: isBrutalScript ? "semantic_hard_failure_rate" : "trimmed_semantic_mismatch_rate"
      },
      turns: turns.map((turn) => ({
        turnIndex: turn.turnIndex,
        prompt: turn.prompt,
        initialOutput: turn.initialOutput,
        baselineOutput: turn.baselineOutput,
        initialGateState: turn.initialGateState,
        gateState: turn.gateState,
        initialExactMatch: turn.initialExactMatch,
        overrideApplied: turn.overrideApplied,
        constraintApplied: turn.constraintApplied,
        overrideWithoutGrounding: turn.overrideWithoutGrounding,
        constraintSource: turn.constraintSource,
        contractExpectedLiteral: turn.contractExpectedLiteral,
        contractExactMatch: turn.contractExactMatch,
        expectedLabel: turn.expectedLabel,
        retryCountUsed: turn.retryCountUsed,
        correctionSucceeded: turn.correctionSucceeded,
        rawMatch: turn.rawMatch,
        jsonParseValid: turn.jsonParseValid,
        schemaValid: turn.schemaValid,
        keyOrderValid: turn.keyOrderValid,
        semanticHardFailure: turn.semanticHardFailure,
        taxonomy: turn.taxonomy,
        telemetry: turn.telemetry
      }))
    };
  }

  function exportRunSnapshot() {
    const snapshot = buildSnapshot();
    downloadTextFile("guardianai_export.json", JSON.stringify(snapshot, null, 2), "application/json");
  }

  async function generateLabReport() {
    if (turns.length === 0 || isGeneratingLabReport) return;

    setIsGeneratingLabReport(true);
    setErrorMessage(null);

    try {
      const snapshot = buildSnapshot();

      const response = await requestJSON<{ markdown: string }>("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ snapshot })
      });

      downloadTextFile("guardianai_lab_report.md", response.markdown, "text/markdown");
    } catch (error) {
      setErrorMessage(`Lab report generation failed: ${error instanceof Error ? error.message : "Unknown"}`);
    } finally {
      setIsGeneratingLabReport(false);
    }
  }

  const keyStatusLabel = !apiKey.trim()
    ? "Server Env / None"
    : apiProvider === "auto"
      ? detectedKeyProvider
        ? providerOptions.find((item) => item.value === detectedKeyProvider)?.label ?? "Detected"
        : "Provided"
      : providerOptions.find((item) => item.value === apiProvider)?.label ?? "Provided";

  return (
    <main className="shell">
      <section className="top-band">
        <div className="left-toolbar">
          <div className="field-block">
            <label>Execution</label>
            <select value={executionMode} onChange={(event) => setExecutionMode(event.target.value as ExecutionMode)} disabled={isRunning}>
              <option value="passive">Passive (Default)</option>
              <option value="assisted">Assisted (Guardian Retry)</option>
            </select>
          </div>

          <div className="field-block">
            <label>Provider</label>
            <select value={apiProvider} onChange={(event) => setApiProvider(event.target.value as APIProvider)}>
              {providerOptions.map((provider) => (
                <option key={provider.value} value={provider.value}>
                  {provider.label}
                </option>
              ))}
            </select>
          </div>

          <div className="field-block wide">
            <label>API Key</label>
            <input
              ref={apiKeyInputRef}
              type="password"
              value={apiKey}
              onChange={(event) => setNormalizedApiKey(event.target.value)}
              onInput={(event) => setNormalizedApiKey((event.target as HTMLInputElement).value)}
              onBlur={(event) => setNormalizedApiKey(event.target.value)}
              onPaste={(event) => {
                const pasted = event.clipboardData.getData("text");
                if (pasted) setNormalizedApiKey(pasted);
              }}
              autoComplete="off"
              placeholder="Enter API key or rely on server env key"
            />
          </div>

          <div className="status-box">
            <div className="status-line">
              <span className={`dot ${statusTone(guardianStatusState)}`} />
              <span>GuardianAI {guardianStatusLabel}</span>
            </div>
            <div className="status-line">
              <span className={`dot ${statusTone(isRunning ? "on" : "off")}`} />
              <span>Run {isRunning ? "ON" : "OFF"}</span>
            </div>
            <div className="status-line">
              <span className={`dot ${statusTone(apiKey.trim() ? "on" : "neutral")}`} />
              <span>Key {keyStatusLabel}</span>
            </div>
          </div>
        </div>

        <div className="right-toolbar">
          <div className="row-actions">
            <button onClick={exportRunSnapshot}>Export JSON</button>
            <button onClick={generateLabReport} disabled={turns.length === 0 || isGeneratingLabReport}>
              {isGeneratingLabReport ? "Generating..." : "Generate Lab Report"}
            </button>
          </div>

          <div className="row-actions">
            {websiteURL ? (
              <a className="button-link" href={websiteURL} target="_blank" rel="noreferrer">
                Website
              </a>
            ) : (
              <button disabled>Website</button>
            )}
            {githubURL ? (
              <a className="button-link" href={githubURL} target="_blank" rel="noreferrer">
                GitHub
              </a>
            ) : (
              <button disabled>GitHub</button>
            )}
            <button onClick={() => setShowReadme(true)}>Lab Doc</button>
            <button onClick={() => setShowSpec(true)}>GuardianAI Core</button>
          </div>
        </div>
      </section>

      {errorMessage ? <p className="error-line">{errorMessage}</p> : null}

      <section className="subtitle-row">
        <span>Comparator: Raw Byte Equality (No Normalization)</span>
        <span>Model: {effectiveModel}</span>
      </section>

      <section className="control-band">
        <div className="control-stack">
          <article className="card run-card">
            <div className="row-actions">
              <button onClick={startExperiment} disabled={isRunning} className="primary">
                Run Experiment
              </button>
              <button onClick={stopExperiment} disabled={!isRunning} className="danger">
                Stop
              </button>
              <button onClick={resetExperiment}>Reset</button>
            </div>

            <div className="temperature-row">
              <div>
                <label>LLM Temperature</label>
              </div>
              <strong>{llmTemperature.toFixed(2)}</strong>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={llmTemperature}
              onChange={(event) => setLlmTemperature(Number(event.target.value))}
            />
            <div className="temperature-row">
              <div>
                <label>GuardianAI Temperature</label>
              </div>
              <strong>{guardianTemperature.toFixed(2)}</strong>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={guardianTemperature}
              onChange={(event) => setGuardianTemperature(Number(event.target.value))}
            />
            <div className="field-block">
              <label>Max Tokens</label>
              <input
                type="number"
                min={8}
                max={2048}
                value={llmMaxTokens}
                onChange={(event) => setLlmMaxTokens(Math.max(8, Math.min(2048, Number(event.target.value) || 8)))}
                disabled={isRunning}
              />
            </div>
            {isBrutalScript ? (
              <p className="tiny">Brutal mode clamps generation to max {Math.min(llmMaxTokens, BRUTAL_MAX_TOKENS_CAP)} tokens.</p>
            ) : null}
            {isBrutalScript ? (
              <div className="field-block">
                <label>Brutal Repetitions</label>
                <input
                  type="number"
                  min={4}
                  max={10000}
                  value={brutalRepetitionCount}
                  onChange={(event) =>
                    setBrutalRepetitionCount(Math.max(4, Math.min(10000, Number(event.target.value) || 4)))
                  }
                  disabled={isRunning}
                />
              </div>
            ) : null}
            <div className="field-block">
              <label>Guardian Retry Cap</label>
              <select
                value={assistedRetryCap}
                onChange={(event) => setAssistedRetryCap(Number(event.target.value))}
                disabled={isRunning || !assistedEnabled}
              >
                {ASSISTED_RETRY_CAP_OPTIONS.map((cap) => (
                  <option key={cap} value={cap}>
                    {cap}
                  </option>
                ))}
              </select>
            </div>
            <p className="tiny mode-note">
              {assistedEnabled
                ? `Assisted Mode: if strict contract fails, Guardian runs up to ${assistedRetryCap} retry passes and measures correction success (GuardianAI temperature: ${guardianTemperature.toFixed(2)}).`
                : "Passive Mode: no retries. The first model output is the final result."}
            </p>
          </article>

          <article className="card contract-card">
            <h3>Pause Handling Policy</h3>
            <div className="policy-lines">
              <p className="tiny">
                <strong>Execution:</strong> {executionModeLabel}
              </p>
              <p className="tiny">
                <strong>Instrument:</strong> Contract Enforcement
              </p>
              <p className="tiny">
                <strong>Comparator:</strong> {contractComparatorMode}
              </p>
              <p className="tiny">
                {assistedEnabled
                  ? `PAUSE handling: retry up to ${assistedRetryCap} times, then keep final gate result.`
                  : "PAUSE handling: no retry path in passive mode."}
              </p>
            </div>
          </article>
        </div>

        <article className="raw-live">
          <header className="raw-live-head">
            <div className="raw-live-title">
              <Image
                src="/GuardianAILogo.png"
                alt="GuardianAI logo"
                width={34}
                height={34}
                className="raw-live-logo"
              />
              <h3>GuardianAI Deterministic Contract Instrument</h3>
            </div>
            <div className="raw-live-head-meta">
              <span>Raw-byte strict mode</span>
            </div>
          </header>

          <div className="raw-live-grid">
            <article className="raw-panel">
              <h4>Panel 1 - Contract Definition</h4>
              <p className="tiny">Expected output (strict contract field)</p>
              <pre className="raw-pre">{liveExpectedLiteral}</pre>
              {isBrutalScript ? (
                <div className="raw-line">
                  <span className="tiny">Expected label</span>
                  <strong>{latestTurn?.expectedLabel ?? "N/A"}</strong>
                </div>
              ) : (
                <div className="raw-line">
                  <span className="tiny">Prompt-declared literal</span>
                  <strong>{latestPromptDeclaredLiteral ?? "N/A"}</strong>
                </div>
              )}
              <div className="raw-line">
                <span className="tiny">Comparison mode</span>
                <strong>{contractComparatorMode}</strong>
              </div>
              {latestLiteralSourceDiff && !isBrutalScript ? (
                <p className="warning-note">
                  Prompt literal differs from strict contract literal. Strict comparator uses the contract field.
                </p>
              ) : null}
            </article>

            <article className="raw-panel">
              <h4>Panel 2 - Live Output</h4>
              <div className="raw-line">
                <span className="tiny">Length</span>
                <strong>{liveOutputLength}</strong>
              </div>
              <div className="raw-line">
                <span className="tiny">Byte count</span>
                <strong>{liveOutputBytes.length}</strong>
              </div>
              {isBrutalScript ? (
                <>
                  <div className="raw-line">
                    <span className="tiny">Expected length</span>
                    <strong>{liveExpectedLength ?? "N/A"}</strong>
                  </div>
                  <div className="raw-line">
                    <span className="tiny">Length exact</span>
                    <strong>{liveLengthExact === null ? "N/A" : liveLengthExact ? "YES" : "NO"}</strong>
                  </div>
                  <div className="raw-line">
                    <span className="tiny">Leading whitespace</span>
                    <strong>{liveLeadingWhitespace ? "YES" : "NO"}</strong>
                  </div>
                  <div className="raw-line">
                    <span className="tiny">Trailing whitespace</span>
                    <strong>{liveTrailingWhitespace ? "YES" : "NO"}</strong>
                  </div>
                </>
              ) : null}
              <p className="tiny">Escaped output literal</p>
              <pre className="raw-pre">{liveOutputEscapedLiteral}</pre>
              <div className="raw-line">
                <span className="tiny">UTF-8 bytes</span>
                <span className="mono raw-bytes">{liveOutputByteVector}</span>
              </div>
            </article>

            <article className="raw-panel">
              <h4>Panel 3 - Contract Result</h4>
              {isBrutalScript ? (
                <>
                  <div className="raw-line">
                    <span className="tiny">Taxonomy</span>
                    <strong>{latestTaxonomyLabel}</strong>
                  </div>
                  <div className="raw-line">
                    <span className="tiny">Raw match</span>
                    <strong>{latestRawMatchLabel}</strong>
                  </div>
                  <div className="raw-line">
                    <span className="tiny">JSON parse valid</span>
                    <strong>{latestJsonParseValidLabel}</strong>
                  </div>
                  <div className="raw-line">
                    <span className="tiny">Schema valid</span>
                    <strong>{latestSchemaValidLabel}</strong>
                  </div>
                  <div className="raw-line">
                    <span className="tiny">Key order valid</span>
                    <strong>{latestKeyOrderValidLabel}</strong>
                  </div>
                  <div className="raw-line">
                    <span className="tiny">Semantic hard failure</span>
                    <strong>{latestSemanticHardFailureLabel}</strong>
                  </div>
                </>
              ) : (
                <>
                  <div className="raw-line">
                    <span className="tiny">Initial exact match</span>
                    <strong>{latestInitialExactMatchLabel}</strong>
                  </div>
                  <div className="raw-line">
                    <span className="tiny">Exact Match</span>
                    <strong>{latestExactMatchLabel}</strong>
                  </div>
                  <div className="raw-line">
                    <span className="tiny">Prompt-aligned match</span>
                    <strong>{latestPromptAlignedLabel}</strong>
                  </div>
                  <div className="raw-line">
                    <span className="tiny">Semantic class</span>
                    <strong>{latestSemanticClassLabel}</strong>
                  </div>
                  <div className="raw-line">
                    <span className="tiny">Hard failures</span>
                    <strong>
                      {deterministicTrimmedSemanticMismatchCount}/{deterministicTrialCount}
                    </strong>
                  </div>
                </>
              )}
              <div className="raw-line">
                <span className="tiny">Gate</span>
                <strong>{latestGateLabel}</strong>
              </div>
              <div className="raw-line">
                <span className="tiny">Retries used</span>
                <strong>{latestTurn?.retryCountUsed ?? 0}</strong>
              </div>
            </article>

            <article className="raw-panel">
              <h4>Panel 4 - Statistical Summary</h4>
              <div className="raw-line">
                <span className="tiny">After N trials</span>
                <strong>{isBrutalScript ? brutalTrialCount : deterministicTrialCount}</strong>
              </div>
              {isBrutalScript ? (
                <>
                  <div className="raw-line">
                    <span className="tiny">Raw-byte mismatch rate</span>
                    <strong>{percentageString(brutalRawByteMismatchRate)}</strong>
                  </div>
                  <div className="raw-line">
                    <span className="tiny">Format-only mismatch rate</span>
                    <strong>{percentageString(brutalFormatOnlyMismatchRate)}</strong>
                  </div>
                  <div className="raw-line">
                    <span className="tiny">Schema violation rate</span>
                    <strong>{percentageString(brutalSchemaViolationRate)}</strong>
                  </div>
                  <div className="raw-line">
                    <span className="tiny">Semantic hard failure rate</span>
                    <strong>{percentageString(brutalSemanticHardFailureRate)}</strong>
                  </div>
                  <div className="raw-line">
                    <span className="tiny">Non-JSON output rate</span>
                    <strong>{percentageString(brutalNonJsonOutputRate)}</strong>
                  </div>
                  <div className="raw-line">
                    <span className="tiny">Exact match rate</span>
                    <strong>{percentageString(brutalExactMatchRate)}</strong>
                  </div>
                  <div className="raw-line">
                    <span className="tiny">95% CI (semantic hard)</span>
                    <strong>{confidenceInterval95(brutalSemanticHardFailureRate, brutalTrialCount)}</strong>
                  </div>
                  {assistedEnabled ? (
                    <div className="raw-line">
                      <span className="tiny">Retries used (total)</span>
                      <strong>{retryCountTotal}</strong>
                    </div>
                  ) : null}
                </>
              ) : assistedEnabled ? (
                <>
                  <div className="raw-line">
                    <span className="tiny">Initial failure rate</span>
                    <strong>{percentageString(initialFailureRate)}</strong>
                  </div>
                  <div className="raw-line">
                    <span className="tiny">Correction success rate</span>
                    <strong>{percentageString(correctionSuccessRate)}</strong>
                  </div>
                  <div className="raw-line">
                    <span className="tiny">Final residual failure rate</span>
                    <strong>{percentageString(deterministicViolationRate)}</strong>
                  </div>
                  <div className="raw-line">
                    <span className="tiny">Retries used (total)</span>
                    <strong>{retryCountTotal}</strong>
                  </div>
                </>
              ) : (
                <>
                  <div className="raw-line">
                    <span className="tiny">Raw failure rate (baseline)</span>
                    <strong>{percentageString(initialFailureRate)}</strong>
                  </div>
                  <div className="raw-line">
                    <span className="tiny">Hard semantic rate (baseline)</span>
                    <strong>{percentageString(baselineHardSemanticFailureRate)}</strong>
                  </div>
                  <div className="raw-line">
                    <span className="tiny">Format-only mismatch rate</span>
                    <strong>{percentageString(deterministicFormatOnlyMismatchRate)}</strong>
                  </div>
                </>
              )}
              {!isBrutalScript ? (
                <div className="raw-line">
                  <span className="tiny">95% CI (raw-byte)</span>
                  <strong>{confidenceInterval95(initialFailureRate, deterministicTrialCount)}</strong>
                </div>
              ) : null}
            </article>
          </div>
        </article>
      </section>

      <section className="body-grid">
        <article className="panel">
          <header>
            <h3>LLM BASELINE</h3>
          </header>

          <div className="panel-controls">
            <label>Script</label>
            <select value={selectedScript} onChange={(event) => setSelectedScript(event.target.value)} disabled={isRunning}>
              {adversarialScripts.map((script) => (
                <option key={script} value={script}>
                  {scriptLabels[script] ?? script}
                </option>
              ))}
            </select>

            <label>{isBrutalScript ? "Repetitions" : "Size"}</label>
            {isBrutalScript ? (
              <input type="text" value={`${Math.max(4, Math.min(10_000, Math.floor(brutalRepetitionCount)))}`} disabled />
            ) : (
              <select value={selectedSize} onChange={(event) => setSelectedSize(Number(event.target.value))} disabled={isRunning}>
                {promptCountOptions.map((size) => (
                  <option key={size.label} value={size.value}>
                    {size.label}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="turn-stream">
            {turns.length === 0 ? <p className="muted">No conversation yet. Press Run Experiment.</p> : null}
            {turns.map((turn) => (
              <section key={turn.id} className="turn-card">
                <h4>Turn {turnProgressLabel(turn.turnIndex, loadedPrompts.length, turnCount, turns)}</h4>
                <label>User</label>
                <pre>{turn.prompt}</pre>
                <label>LLM Output (final)</label>
                <pre>{turn.baselineOutput}</pre>
                <p className="tiny">
                  Retries used: {turn.retryCountUsed}
                  {turn.retryCountUsed > 0 ? ` | Correction ${turn.correctionSucceeded ? "succeeded" : "failed"}` : ""}
                </p>
                {isBrutalScript ? (
                  <p className="tiny">
                    Taxonomy: {toBrutalTaxonomyLabel(turn.taxonomy)} | JSON: {boolLabel(turn.jsonParseValid)} | Schema:{" "}
                    {boolLabel(turn.schemaValid)}
                  </p>
                ) : null}
              </section>
            ))}
          </div>
        </article>

        <article className="panel">
          <header className="monitor-header">
            <div>
              <h3>Deterministic Contract Monitor</h3>
              <p className="muted">Contract Monitor Active</p>
            </div>
            <div className="stats-line mono">
              <span>MODE: {assistedEnabled ? "ASSISTED" : "PASSIVE"}</span>
              <span>TURNS: {turnCount}</span>
              <span>PAUSES: {pauseCount}</span>
              <span>RETRIES: {retryCountTotal}</span>
              <span>CONSTRAINTS: {constraintCount}</span>
              <span>OBSERVATIONS: {guardianEnabled ? turns.length : 0}</span>
            </div>
          </header>

          <div className="turn-stream">
            {latestTurn ? (
              <section className="latest-card">
                <h4>Latest Turn {turnProgressLabel(latestTurn.turnIndex, loadedPrompts.length, turnCount, turns)}</h4>
                <label>Prompt</label>
                <p>{latestTurn.prompt}</p>
                <label>LLM Output</label>
                <p>{latestTurn.baselineOutput}</p>
                {isBrutalScript ? (
                  <>
                    <label>Contract expected (strict)</label>
                    <p className="mono">{latestTurn.contractExpectedLiteral ?? "n/a"}</p>
                    <label>Expected label</label>
                    <p className="mono">{latestTurn.expectedLabel ?? "n/a"}</p>
                    <label>Taxonomy</label>
                    <p className="mono">{latestTaxonomyLabel}</p>
                    <label>Raw match</label>
                    <p className="mono">{latestRawMatchLabel}</p>
                    <label>JSON parse valid</label>
                    <p className="mono">{latestJsonParseValidLabel}</p>
                    <label>Schema valid</label>
                    <p className="mono">{latestSchemaValidLabel}</p>
                    <label>Key order valid</label>
                    <p className="mono">{latestKeyOrderValidLabel}</p>
                    <label>Semantic hard failure</label>
                    <p className="mono">{latestSemanticHardFailureLabel}</p>
                  </>
                ) : (
                  <>
                    <label>Contract expected (strict)</label>
                    <p className="mono">{latestTurn.contractExpectedLiteral ?? "n/a"}</p>
                    <label>Prompt literal</label>
                    <p className="mono">{latestPromptDeclaredLiteral ?? "n/a"}</p>
                    <label>Initial compliance</label>
                    <p className="mono">{latestInitialExactMatchLabel}</p>
                    <label>Compliance</label>
                    <p className="mono">{latestComplianceLabel}</p>
                  </>
                )}
                <label>Retries used</label>
                <p className="mono">{latestTurn.retryCountUsed}</p>
                {latestTurn.retryCountUsed > 0 ? (
                  <>
                    <label>Correction</label>
                    <p className="mono">{latestTurn.correctionSucceeded ? "SUCCESS" : "FAILED"}</p>
                  </>
                ) : null}
                {latestLiteralSourceDiff && !isBrutalScript ? (
                  <p className="warning-note">
                    Prompt literal differs from strict contract literal. Gate uses the strict contract field.
                  </p>
                ) : null}
                <label>Gate</label>
                <p className={`gate-pill ${CONTROL_LABELS[latestTurn.gateState].tone}`}>{latestTurn.gateState}</p>
              </section>
            ) : (
              <p className="muted">No turn telemetry yet.</p>
            )}

            {turns
              .slice()
              .reverse()
              .map((turn) => {
                const mismatchKind = turn.contractExpectedLiteral
                  ? classifyMismatchKind(turn.contractExpectedLiteral, turn.baselineOutput, Boolean(turn.contractExactMatch))
                  : null;
                const taxonomyLabel = toBrutalTaxonomyLabel(turn.taxonomy);
                const promptDeclaredLiteral = extractPromptDeclaredLiteral(turn.prompt);
                const promptAlignedMatch =
                  promptDeclaredLiteral !== null ? turn.baselineOutput.trim() === promptDeclaredLiteral.trim() : null;
                const literalSourceDiff =
                  turn.contractExpectedLiteral && promptDeclaredLiteral
                    ? turn.contractExpectedLiteral.trim() !== promptDeclaredLiteral.trim()
                    : false;
                const complianceLabel = turn.contractExactMatch
                  ? "Exact match"
                  : promptAlignedMatch
                    ? "Strict mismatch (prompt-aligned)"
                    : "Literal mismatch";
                const initialComplianceLabel =
                  turn.initialExactMatch === undefined ? "n/a" : turn.initialExactMatch ? "initial exact" : "initial failure";

                return (
                  <section key={`monitor-${turn.id}`} className="decision-card">
                    <div className="decision-top">
                      <strong>
                        Turn {turnProgressLabel(turn.turnIndex, loadedPrompts.length, turnCount, turns)}: {turn.gateState}
                      </strong>
                      <span className={`gate-pill ${CONTROL_LABELS[turn.gateState].tone}`}>{turn.gateState}</span>
                    </div>
                    <p className="muted">Decision from GuardianAI V3 Gate</p>

                    {turn.contractExpectedLiteral ? (
                      isBrutalScript ? (
                        <>
                          <p className="mono">Contract expected: {turn.contractExpectedLiteral}</p>
                          <p className="mono">Expected label: {turn.expectedLabel ?? "n/a"}</p>
                          <p className="mono">Taxonomy: {taxonomyLabel}</p>
                          <p className="mono">Raw match: {boolLabel(turn.rawMatch)}</p>
                          <p className="mono">JSON parse valid: {boolLabel(turn.jsonParseValid)}</p>
                          <p className="mono">Schema valid: {boolLabel(turn.schemaValid)}</p>
                          <p className="mono">Key order valid: {boolLabel(turn.keyOrderValid)}</p>
                          <p className="mono">Semantic hard failure: {boolLabel(turn.semanticHardFailure)}</p>
                          <p className="mono">Retries used: {turn.retryCountUsed}</p>
                          {turn.retryCountUsed > 0 ? (
                            <p className="mono">Correction: {turn.correctionSucceeded ? "SUCCESS" : "FAILED"}</p>
                          ) : null}
                        </>
                      ) : (
                        <>
                          <p className="mono">Contract expected: {turn.contractExpectedLiteral}</p>
                          <p className="mono">Prompt literal: {promptDeclaredLiteral ?? "n/a"}</p>
                          <p className="mono">Initial compliance: {initialComplianceLabel}</p>
                          <p className="mono">Compliance: {complianceLabel}</p>
                          <p className="mono">Retries used: {turn.retryCountUsed}</p>
                          {turn.retryCountUsed > 0 ? (
                            <p className="mono">Correction: {turn.correctionSucceeded ? "SUCCESS" : "FAILED"}</p>
                          ) : null}
                          <p className="mono">Mismatch class: {toMismatchLabel(mismatchKind)}</p>
                          {literalSourceDiff ? (
                            <p className="warning-note">Prompt literal differs from strict contract literal on this turn.</p>
                          ) : null}
                        </>
                      )
                    ) : null}

                    {turn.overrideApplied ? <p className="chip warn">Override applied</p> : null}
                    {turn.constraintApplied ? <p className="chip good">Constraint applied ({turn.constraintSource ?? "n/a"})</p> : null}
                  </section>
                );
              })}
          </div>
        </article>
      </section>

      {showReadme ? (
        <SectionDocModal title="Deterministic Contract Lab - README" body={deterministicReadmeText} onClose={() => setShowReadme(false)} />
      ) : null}

      {showSpec ? (
        <SectionDocModal title="GuardianAI Core - Behavioral Specification" body={guardianSpecText} onClose={() => setShowSpec(false)} />
      ) : null}

      {showPauseModal ? (
        <PauseModal
          busy={false}
          onContinue={() => setShowPauseModal(false)}
          onStop={() => {
            stopExperiment();
            setShowPauseModal(false);
          }}
          onCancel={() => setShowPauseModal(false)}
        />
      ) : null}
    </main>
  );
}
