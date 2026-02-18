import { NextRequest, NextResponse } from "next/server";
import type { ExportSnapshot } from "@/lib/types";

function pct(value: number | null): string {
  return value === null ? "N/A" : `${(value * 100).toFixed(1)}%`;
}

function ci95(rate: number | null, trials: number): string {
  if (rate === null || trials <= 0) return "N/A";
  const z = 1.96;
  const variance = (rate * (1 - rate)) / trials;
  const margin = z * Math.sqrt(variance);
  const low = Math.max(0, rate - margin);
  const high = Math.min(1, rate + margin);
  return `[${(low * 100).toFixed(1)}%, ${(high * 100).toFixed(1)}%]`;
}

function line(value?: string | null): string {
  return value && value.trim().length > 0 ? value : "n/a";
}

function num(value: number | null): string {
  return value === null ? "N/A" : value.toFixed(2);
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { snapshot?: ExportSnapshot };
    const snapshot = body.snapshot;

    if (!snapshot) {
      return NextResponse.json({ error: "Snapshot is required." }, { status: 400 });
    }

    const turns = snapshot.turns;
    const topViolations = turns
      .filter((turn) => turn.contractExactMatch === false)
      .slice(0, 20)
      .map((turn) => `- Turn ${turn.turnIndex}: expected ${line(turn.contractExpectedLiteral)}, gate ${turn.gateState}, output \`${turn.baselineOutput.slice(0, 120)}\``)
      .join("\n");

    const ledger = turns
      .slice(0, 80)
      .map((turn) => {
        const expected = line(turn.contractExpectedLiteral);
        const exact = turn.contractExactMatch === undefined ? "n/a" : turn.contractExactMatch ? "exact" : "mismatch";
        const flags = [
          turn.overrideApplied ? "override" : null,
          turn.constraintApplied ? "constraint" : null,
          turn.overrideWithoutGrounding ? "ungrounded_override" : null
        ]
          .filter(Boolean)
          .join(", ");

        return `- Turn ${turn.turnIndex}: expected ${expected} | contract ${exact} | gate ${turn.gateState}${flags ? ` | flags ${flags}` : ""}`;
      })
      .join("\n");

    const metrics = snapshot.metrics;
    const assistedEnabled = metrics.assistedEnabled ?? false;
    const assistedRetryCap = metrics.assistedRetryCap ?? 0;
    const isBrutal = snapshot.selectedScript === "json_contract_brutal_v2";
    const initialFailureCount = metrics.initialFailureCount ?? metrics.rawByteMismatchCount;
    const initialFailureRate = metrics.initialFailureRate ?? metrics.rawByteMismatchRate;
    const baselineHardSemanticFailureCount =
      metrics.baselineHardSemanticFailureCount ?? metrics.trimmedSemanticMismatchCount;
    const baselineHardSemanticFailureRate =
      metrics.baselineHardSemanticFailureRate ?? metrics.trimmedSemanticMismatchRate;
    const correctionSuccessCount = metrics.correctionSuccessCount ?? 0;
    const correctionSuccessRate = metrics.correctionSuccessRate ?? null;
    const finalResidualFailureCount = metrics.finalResidualFailureCount ?? metrics.rawByteMismatchCount;
    const finalResidualFailureRate = metrics.finalResidualFailureRate ?? metrics.rawByteMismatchRate;
    const retriesUsedTotal = metrics.retriesUsedTotal ?? 0;
    const retriesUsedAverage = metrics.retriesUsedAverage ?? null;
    const effectiveBrutalMaxTokens =
      snapshot.llmMaxTokens === undefined ? "48" : String(Math.min(snapshot.llmMaxTokens, 48));
    const brutalFailureExamples = turns
      .filter((turn) => turn.taxonomy && turn.taxonomy !== "EXACT_MATCH")
      .slice(0, 5)
      .map((turn) => {
        const taxonomy = turn.taxonomy ?? "n/a";
        return `- Turn ${turn.turnIndex}: ${taxonomy} | expected ${line(turn.contractExpectedLiteral)} | output \`${turn.baselineOutput.slice(0, 120)}\``;
      })
      .join("\n");

    const markdown = isBrutal
      ? `## Deterministic JSON Contract Lab - Brutal v2 (Nested)
- Objective: strict deterministic nested JSON contract enforcement under raw-byte exact mode.
- Guardian contract gate flags any non-exact turn as PAUSE.
- Model: ${snapshot.selectedModel}
- Temperature: ${snapshot.llmTemperature.toFixed(2)}
- GuardianAI temperature: ${(snapshot.guardianTemperature ?? 0).toFixed(2)}
- Turns (N): ${metrics.turns}
- Execution profile: ${assistedEnabled ? `Assisted (max ${assistedRetryCap} retries)` : "Passive (no retries)"}.

## Core Rates
| Metric | Value |
| --- | --- |
| Exact match rate | ${pct(metrics.exactMatchRate ?? null)} |
| Raw-byte mismatch rate | ${pct(metrics.rawByteMismatchRate)} |
| Format-only mismatch rate | ${pct(metrics.formatOnlyMismatchRate)} |
| Schema violation rate | ${pct(metrics.schemaViolationRate ?? null)} |
| Semantic hard failure rate | ${pct(metrics.semanticHardFailureRate ?? null)} |
| Non-JSON output rate | ${pct(metrics.nonJsonOutputRate ?? null)} |
| 95% CI (semantic hard failure) | ${ci95(metrics.semanticHardFailureRate ?? null, metrics.turns)} |

## Assisted Correction
| Metric | Value |
| --- | --- |
| Initial failure rate | ${pct(initialFailureRate)} |
| Correction success rate | ${assistedEnabled ? pct(correctionSuccessRate) : "N/A (assisted off)"} |
| Final residual failure rate | ${pct(finalResidualFailureRate)} |
| Retries used total | ${retriesUsedTotal} |
| Retries used average per turn | ${num(retriesUsedAverage)} |

## Example Failures (First 5)
${brutalFailureExamples || "- None"}

## Run Configuration
- Provider preference: ${snapshot.apiProvider}
- Resolved provider: ${snapshot.resolvedLLMProvider}
- Script: ${snapshot.selectedScript}
- Repetitions: ${snapshot.promptCount}
- Max tokens: ${snapshot.llmMaxTokens ?? "n/a"}
- Effective brutal max tokens: ${effectiveBrutalMaxTokens}
- Contract comparator: ${snapshot.contractComparator}
- Pause policy: ${snapshot.pausePolicy}
`
      : `## Executive Summary
- The run evaluated deterministic contract compliance under strict raw byte equality with no normalization.
- Execution profile: ${assistedEnabled ? `Assisted (max ${assistedRetryCap} retries)` : "Passive baseline (no retries)"}.
- Turns: ${metrics.turns}; pauses: ${metrics.pauses}; constraints: ${metrics.constraints}; retries used: ${retriesUsedTotal}.
- Baseline raw failure rate: ${pct(initialFailureRate)} (${initialFailureCount}/${metrics.turns || 0}).
- Baseline hard semantic rate: ${pct(baselineHardSemanticFailureRate)} (${baselineHardSemanticFailureCount}/${metrics.turns || 0}).
${assistedEnabled ? `- Correction success rate: ${pct(correctionSuccessRate)} (${correctionSuccessCount}/${initialFailureCount || 0}).\n- Final residual failure rate: ${pct(finalResidualFailureRate)} (${finalResidualFailureCount}/${metrics.turns || 0}).` : "- Assisted correction is disabled; residual failure equals baseline failure."}

## Run Configuration Audit
- Provider preference: ${snapshot.apiProvider}
- Resolved provider: ${snapshot.resolvedLLMProvider}
- Model: ${snapshot.selectedModel}
- Script: ${snapshot.selectedScript}
- Prompt count selection: ${snapshot.promptCount}
- Execution mode: ${snapshot.executionMode}
- Contract comparator: ${snapshot.contractComparator}
- Pause policy: ${snapshot.pausePolicy}
- LLM temperature: ${snapshot.llmTemperature.toFixed(2)}
- GuardianAI temperature: ${(snapshot.guardianTemperature ?? 0).toFixed(2)}
- Max tokens: ${snapshot.llmMaxTokens ?? "n/a"}

## Deterministic Reporting Structure
| Metric | Value |
| --- | --- |
| Baseline raw failure rate (no assist) | ${pct(initialFailureRate)} |
| Baseline hard semantic rate (no assist) | ${pct(baselineHardSemanticFailureRate)} |
| Initial failures | ${initialFailureCount} |
| Correction success rate | ${assistedEnabled ? pct(correctionSuccessRate) : "N/A (assisted off)"} |
| Final residual failure rate | ${pct(finalResidualFailureRate)} |
| Retries used total | ${retriesUsedTotal} |
| Retries used average per turn | ${num(retriesUsedAverage)} |

## Violation Taxonomy
- Exact match (final): ${(metrics.turns || 0) - metrics.rawByteMismatchCount}
- Strict contract violations (final): ${metrics.rawByteMismatchCount}
- Formatting-only mismatches: ${metrics.formatOnlyMismatchCount}
- Hard semantic failures (final): ${metrics.trimmedSemanticMismatchCount}

Representative strict violations:
${topViolations || "- None"}

## Turn-by-Turn Contract Ledger
${ledger || "- No turns recorded."}

## Interpretation
- Passive mode measures intrinsic reliability.
- Assisted mode measures corrective power under a capped retry budget.
- No infinite retry loop is used; retry budget is bounded at ${assistedRetryCap || 0}.

Termination Cause: ${metrics.turns === 0 ? "No turns executed" : "Run stopped after scripted loop completion or operator stop."}
`;

    return NextResponse.json({ markdown });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
