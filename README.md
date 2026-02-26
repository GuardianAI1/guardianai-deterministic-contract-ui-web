# GuardianAI Deterministic Contract UI (Web)

This is a web migration of the macOS SwiftUI Deterministic Contract Lab.

## Framing

GuardianAI doesn't detect wrong answers.  
It detects when systems close faster than their constraints justify.

In deterministic contracts, this shows up instantly because the constraint is binary.  
In real pipelines, the same drift often unfolds gradually across steps and decisions.

The lab demo isolates the mechanism.  
In production systems, that same dynamic can remain invisible unless something observes it.

## What this includes

- Deterministic contract experiment UI in browser
- Script picker + prompt count controls
- Provider selection and key handling (Together/OpenAI/Anthropic/Google/Mistral)
- Default Together model: `google/gemma-3n-e4b-it`
- Guardian Core observe/decide integration
- Assisted constraint proposal flow on PAUSE
- Export snapshot JSON
- Generate markdown lab report
- Script provenance audit fields (path/source URL/SHA-256 in exports)
- Download active script JSONL from UI
- README/Core docs modals

## Run locally

1. Install dependencies:
   ```bash
   npm install
   ```
2. Create env file:
   ```bash
   cp .env.example .env.local
   ```
3. Start dev server:
   ```bash
   npm run dev
   ```
4. Open [http://localhost:3000](http://localhost:3000)

## Environment variables

- `GUARDIAN_CORE_URL` (default: `http://127.0.0.1:18101`)
- `GUARDIAN_GATE_URL` (default: `http://127.0.0.1:18102`)
- `GUARDIAN_ENDPOINT_KEY` (required when `/core/*` and `/gate/*` are key-protected at Nginx)
- Optional server-side default keys:
  - `TOGETHER_API_KEY`
  - `OPENAI_API_KEY`
  - `OPENAI_ORGANIZATION` (optional)
  - `OPENAI_PROJECT` (optional)
  - `ANTHROPIC_API_KEY`
  - `GOOGLE_API_KEY`
  - `MISTRAL_API_KEY`
- Optional UI website button target:
  - `NEXT_PUBLIC_GUARDIAN_WEBSITE_URL`
- Optional UI GitHub button target:
  - `NEXT_PUBLIC_GITHUB_REPO_URL`

## Deploy notes

- This project can deploy on Vercel.
- For production, prefer `GUARDIAN_CORE_URL=https://guardianai.fr/core` and `GUARDIAN_GATE_URL=https://guardianai.fr/gate`.
- Keep API keys on server env vars only.
- Do not expose provider keys in client-side code.
