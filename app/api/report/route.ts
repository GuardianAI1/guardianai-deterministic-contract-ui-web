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

function safeRate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return numerator / denominator;
}

function expectedLiteral(value?: string | null): string {
  return (value ?? "").trim();
}

function firstLabelFromOutput(output: string): string | null {
  const match = output.match(/[A-Za-z0-9]/);
  return match ? match[0] : null;
}

function sameSingleLabel(expected: string, observed: string | null): boolean {
  if (!observed) return false;
  if (/^[A-Za-z]$/.test(expected)) {
    return observed.toUpperCase() === expected.toUpperCase();
  }
  return observed === expected;
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
    const scriptProof = snapshot.scriptProvenance;
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

    const comparableTurns = turns.filter((turn) => expectedLiteral(turn.contractExpectedLiteral).length > 0);
    const comparableCount = comparableTurns.length;
    const rawFailureCount = comparableTurns.filter((turn) => turn.baselineOutput !== expectedLiteral(turn.contractExpectedLiteral)).length;
    const rawFailureRate = safeRate(rawFailureCount, comparableCount);

    const trimmedFailureCount = comparableTurns.filter((turn) => turn.baselineOutput.trim() !== expectedLiteral(turn.contractExpectedLiteral)).length;
    const trimmedFailureRate = safeRate(trimmedFailureCount, comparableCount);

    const singleLabelTurns = comparableTurns.filter((turn) => /^[A-Za-z0-9]$/.test(expectedLiteral(turn.contractExpectedLiteral)));
    const singleLabelCount = singleLabelTurns.length;
    const firstLabelFailureCount = singleLabelTurns.filter((turn) => {
      const expected = expectedLiteral(turn.contractExpectedLiteral);
      return !sameSingleLabel(expected, firstLabelFromOutput(turn.baselineOutput));
    }).length;
    const firstLabelFailureRate = safeRate(firstLabelFailureCount, singleLabelCount);

    const semanticOnlyFailureCount =
      singleLabelCount === comparableCount && singleLabelCount > 0
        ? firstLabelFailureCount
        : baselineHardSemanticFailureCount;
    const semanticOnlyFailureRate =
      singleLabelCount === comparableCount && singleLabelCount > 0
        ? firstLabelFailureRate
        : baselineHardSemanticFailureRate;

    const formattingDominatedShare =
      rawFailureCount > 0 && semanticOnlyFailureCount >= 0
        ? safeRate(Math.max(rawFailureCount - semanticOnlyFailureCount, 0), rawFailureCount)
        : null;
    const strictFailureDriverLine =
      formattingDominatedShare === null
        ? "Formatting-vs-semantic strict-failure decomposition unavailable."
        : `${pct(formattingDominatedShare)} of strict failures are formatting/instruction-spillover artifacts; ${pct(
            safeRate(semanticOnlyFailureCount, rawFailureCount)
          )} are semantic errors.`;

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
- Script path: ${line(scriptProof?.scriptPath)}
- Script source URL: ${line(scriptProof?.scriptSourceUrl)}
- Script SHA-256: ${line(scriptProof?.scriptSha256)}
- Script lines: ${scriptProof?.scriptLineCount ?? "n/a"}
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
- Script path: ${line(scriptProof?.scriptPath)}
- Script source URL: ${line(scriptProof?.scriptSourceUrl)}
- Script SHA-256: ${line(scriptProof?.scriptSha256)}
- Script lines: ${scriptProof?.scriptLineCount ?? "n/a"}
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

## Layered Comparator Analysis (Post-Run, Non-Enforcing)
To decompose strict failures, we apply post-hoc analytical comparators to stored outputs only.
- GuardianAI production enforcement remains Raw Byte-Exact only.
- These layers do not alter gate behavior, outputs, or stored run data.

| Comparator Layer | Failure Rate | Interpretation |
| --- | --- | --- |
| Raw Byte-Exact (enforcing) | ${pct(rawFailureRate)} | Strict deterministic contract compliance. |
| Trimmed Exact (analysis-only) | ${pct(trimmedFailureRate)} | Removes leading/trailing whitespace and newline artifacts only. |
| First-Label Extraction (analysis-only) | ${singleLabelCount > 0 ? pct(firstLabelFailureRate) : "N/A"} | Extracts the first label token (${singleLabelCount > 0 ? "A-Z/0-9" : "not applicable"}) to remove instruction spillover. |
| Semantic-Only Proxy (analysis-only) | ${pct(semanticOnlyFailureRate)} | Label-level correctness after non-semantic formatting effects are discounted. |

- ${strictFailureDriverLine}

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
