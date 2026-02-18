export type APIProvider = "together" | "openAI" | "anthropic" | "google" | "mistral" | "auto";
export type ExecutionMode = "passive" | "assisted";
export type BrutalTaxonomy =
  | "EXACT_MATCH"
  | "FORMAT_ONLY_DRIFT"
  | "SCHEMA_VIOLATION"
  | "SEMANTIC_HARD_FAILURE"
  | "NON_JSON_OUTPUT";

export type GateState = "CONTINUE" | "PAUSE" | "YIELD";

export type ConstraintSource = "Assisted Constraint Proposal" | "Auto Minimal Constraint";

export interface ScriptPrompt {
  id?: number;
  prompt: string;
  expected_literal?: string;
  expected_label?: string;
  category?: string;
  expected_behavior?: string;
  [key: string]: unknown;
}

export interface CoreTelemetry {
  authority_trend: string;
  revision_mode: string;
  grounding_markers: unknown[];
  temporal_resistance_detected: boolean;
  trajectory_state: string;
}

export interface ExperimentTurn {
  id: string;
  turnIndex: number;
  prompt: string;
  initialOutput: string;
  baselineOutput: string;
  initialGateState: GateState;
  gateState: GateState;
  telemetry?: CoreTelemetry;
  initialExactMatch?: boolean;
  overrideApplied: boolean;
  constraintApplied: boolean;
  overrideWithoutGrounding: boolean;
  constraintSource?: ConstraintSource;
  contractExpectedLiteral?: string;
  contractExactMatch?: boolean;
  expectedLabel?: string;
  retryCountUsed: number;
  correctionSucceeded: boolean;
  rawMatch?: boolean;
  jsonParseValid?: boolean;
  schemaValid?: boolean;
  keyOrderValid?: boolean;
  semanticHardFailure?: boolean;
  taxonomy?: BrutalTaxonomy;
}

export interface ExportMetrics {
  turns: number;
  pauses: number;
  retriesUsedTotal: number;
  retriesUsedAverage: number | null;
  initialFailureCount: number;
  initialFailureRate: number | null;
  correctionSuccessCount: number;
  correctionSuccessRate: number | null;
  finalResidualFailureCount: number;
  finalResidualFailureRate: number | null;
  baselineHardSemanticFailureCount: number;
  baselineHardSemanticFailureRate: number | null;
  assistedRetryCap: number;
  assistedEnabled: boolean;
  schemaViolationRate?: number | null;
  semanticHardFailureRate?: number | null;
  exactMatchRate?: number | null;
  nonJsonOutputRate?: number | null;
  overrides: number;
  constraints: number;
  observations: number;
  rawByteMismatchCount: number;
  rawByteMismatchRate: number | null;
  trimmedSemanticMismatchCount: number;
  trimmedSemanticMismatchRate: number | null;
  formatOnlyMismatchCount: number;
  formatOnlyMismatchRate: number | null;
  primarySafetyMetric: string;
}

export interface ExportTurn {
  turnIndex: number;
  prompt: string;
  initialOutput: string;
  baselineOutput: string;
  initialGateState: GateState;
  gateState: GateState;
  initialExactMatch?: boolean;
  overrideApplied: boolean;
  constraintApplied: boolean;
  overrideWithoutGrounding: boolean;
  constraintSource?: ConstraintSource;
  contractExpectedLiteral?: string;
  contractExactMatch?: boolean;
  expectedLabel?: string;
  retryCountUsed: number;
  correctionSucceeded: boolean;
  rawMatch?: boolean;
  jsonParseValid?: boolean;
  schemaValid?: boolean;
  keyOrderValid?: boolean;
  semanticHardFailure?: boolean;
  taxonomy?: BrutalTaxonomy;
  telemetry?: CoreTelemetry;
}

export interface ScriptProvenance {
  scriptId: string;
  scriptLabel: string;
  scriptPath: string;
  scriptSourceUrl?: string;
  scriptSha256?: string;
  scriptLineCount?: number;
}

export interface ExportSnapshot {
  exportedAt: string;
  apiProvider: string;
  resolvedLLMProvider: string;
  selectedModel: string;
  llmTemperature: number;
  guardianTemperature?: number;
  llmMaxTokens?: number;
  selectedScript: string;
  promptCount: string;
  brutalRepetitionCount?: number;
  executionMode: string;
  guardianDetectionMode: string;
  contractComparator: string;
  pausePolicy: string;
  guardianEnabled: boolean;
  scriptProvenance?: ScriptProvenance;
  metrics: ExportMetrics;
  turns: ExportTurn[];
}
