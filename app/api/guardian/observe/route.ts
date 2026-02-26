import { NextRequest, NextResponse } from "next/server";
import type { GateState } from "@/lib/types";

type ObserveRequestBody = {
  turnId?: number;
  output?: string;
  deterministicConstraint?: string | null;
};

type GuardianObserveResponse = {
  telemetry: {
    transitions?: Record<string, number>;
    temporal_spacing?: number;
  };
  structural_recommendation: string;
  reason_codes: string[];
};

type GuardianGateResponse = {
  final_gate_decision: string;
  reason_codes: string[];
};

function normalizeBaseURL(value: string): string {
  const trimmed = value.trim();
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function mapFinalGateDecision(value: string): GateState {
  const upper = value.toUpperCase();
  if (upper === "PAUSE" || upper === "DEFER") return "PAUSE";
  if (upper === "YIELD") return "YIELD";
  return "CONTINUE";
}

function guardianAuthHeaders(): Record<string, string> {
  const endpointKey = (process.env.GUARDIAN_ENDPOINT_KEY ?? "").trim();
  if (!endpointKey) return {};
  return { "X-Guardian-Key": endpointKey };
}

async function requestJSON<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
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

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(payload)}`);
  }

  return payload as T;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as ObserveRequestBody;
    const output = (body.output ?? "").toString();
    if (!output.trim()) {
      return NextResponse.json({ error: "Output is required." }, { status: 400 });
    }

    const turnId = Number.isFinite(body.turnId) ? Number(body.turnId) : 0;

    const coreURL = normalizeBaseURL(process.env.GUARDIAN_CORE_URL ?? "http://127.0.0.1:18101");
    const gateURL = normalizeBaseURL(process.env.GUARDIAN_GATE_URL ?? "http://127.0.0.1:18102");

    const observePayload = {
      event_id: `turn-${turnId}`,
      timestamp: Date.now() / 1000,
      raw_output: output
    };

    const observeResponse = await requestJSON<GuardianObserveResponse>(`${coreURL}/observe`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...guardianAuthHeaders() },
      body: JSON.stringify(observePayload)
    });

    const gatePayload = {
      structural_recommendation: observeResponse.structural_recommendation,
      raw_output: output,
      deterministic_constraint: body.deterministicConstraint ?? null
    };

    const gateResponse = await requestJSON<GuardianGateResponse>(`${gateURL}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...guardianAuthHeaders() },
      body: JSON.stringify(gatePayload)
    });

    const transition = observeResponse.telemetry?.transitions?.transition_index ?? 0;
    const temporalDetected = (observeResponse.telemetry?.temporal_spacing ?? 1) <= 0.2 && transition <= 0.2;

    const telemetry = {
      authority_trend: transition.toFixed(2),
      revision_mode: observeResponse.structural_recommendation.toLowerCase(),
      grounding_markers: [],
      temporal_resistance_detected: temporalDetected,
      trajectory_state: observeResponse.reason_codes?.[0] ?? observeResponse.structural_recommendation
    };

    return NextResponse.json({
      gateState: mapFinalGateDecision(gateResponse.final_gate_decision),
      telemetry
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
