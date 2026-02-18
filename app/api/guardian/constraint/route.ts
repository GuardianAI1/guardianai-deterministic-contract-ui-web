import { NextRequest, NextResponse } from "next/server";

function normalizeBaseURL(value: string): string {
  const trimmed = value.trim();
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { content?: string };
    const content = (body.content ?? "").toString().trim();
    if (!content) {
      return NextResponse.json({ error: "Constraint content is required." }, { status: 400 });
    }

    const gateURL = normalizeBaseURL(process.env.GUARDIAN_GATE_URL ?? "http://127.0.0.1:18102");

    const response = await fetch(`${gateURL}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        structural_recommendation: "CONTINUE",
        raw_output: content.slice(0, 20_000),
        deterministic_constraint: null
      }),
      cache: "no-store"
    });

    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};

    if (!response.ok) {
      return NextResponse.json({ error: `HTTP ${response.status}: ${JSON.stringify(payload)}` }, { status: response.status });
    }

    return NextResponse.json({ ok: true, gateResponse: payload });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
