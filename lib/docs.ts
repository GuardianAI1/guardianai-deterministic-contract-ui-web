export const deterministicReadmeText = `Overview
The Deterministic Contract Lab evaluates strict literal compliance of LLM outputs under controlled interface contracts.
This experiment measures whether a language model can reliably produce exact expected literals under deterministic constraints.
It does not evaluate reasoning depth, factual correctness beyond the expected label, or semantic understanding beyond contract compliance.

Experimental Goal
To quantify deterministic output compliance under strict literal contracts.
Specifically:
- Can the model output exactly the expected literal?
- How often does formatting drift occur?
- How often does true semantic wrong-answer drift occur?

Gate Behavior in This Mode
In Deterministic Contract Lab mode:
- Structural trajectory logic is disabled.
- GuardianAI performs strict contract enforcement only.
- Gate decisions are based solely on comparator outcomes.

Scope
This lab measures deterministic contract compliance, not full alignment or domain expertise.`;

export const guardianSpecText = `Overview
GuardianAI Core is a structural observation and gating engine.
It produces telemetry and gate decisions derived from structural properties of model outputs.

Core Design Invariants
1. Structural Signal Basis
2. No Semantic Interpretation
3. Deterministic Gate Logic
4. Trajectory Awareness
5. Separation from Contract Enforcement

Intended Role
GuardianAI Core is a structural boundary observer designed to detect instability and deterministic contract drift at the interface level.`;
