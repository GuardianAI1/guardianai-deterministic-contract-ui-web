import type { ExperimentTurn } from "@/lib/types";

export type DeterministicMismatchKind = "exact" | "formattingOnly" | "semanticHardFailure";

export function safeRate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return numerator / denominator;
}

function boundaryNormalizedLiteral(value: string): string {
  return value
    .trim()
    .replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, "")
    .toLowerCase();
}

function hasExpectedPrefixWithBoundary(expectedLiteral: string, rawOutput: string): boolean {
  const trimmed = rawOutput.trim();
  if (!trimmed.startsWith(expectedLiteral)) return false;
  if (trimmed.length === expectedLiteral.length) return true;
  const nextChar = trimmed.charAt(expectedLiteral.length);
  return /[\s\p{P}]/u.test(nextChar);
}

export function classifyMismatchKind(expectedLiteral: string, rawOutput: string, exactMatch: boolean): DeterministicMismatchKind {
  if (exactMatch) return "exact";

  const expectedTrimmed = boundaryNormalizedLiteral(expectedLiteral);
  const outputTrimmed = boundaryNormalizedLiteral(rawOutput);

  if (expectedTrimmed.length === 0 || outputTrimmed.length === 0) {
    return "semanticHardFailure";
  }

  if (expectedTrimmed === outputTrimmed) return "formattingOnly";
  if (hasExpectedPrefixWithBoundary(expectedLiteral.trim(), rawOutput)) return "formattingOnly";

  return "semanticHardFailure";
}

export function mismatchKindForTurn(turn: ExperimentTurn): DeterministicMismatchKind | null {
  if (turn.contractExactMatch === undefined || turn.contractExactMatch === null) return null;
  const expected = turn.contractExpectedLiteral;
  if (!expected) return turn.contractExactMatch ? "exact" : "semanticHardFailure";
  return classifyMismatchKind(expected, turn.baselineOutput, turn.contractExactMatch);
}

export function percentageString(value: number | null): string {
  if (value === null) return "N/A";
  return `${(value * 100).toFixed(1)}%`;
}
