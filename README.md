# GuardianAI Deterministic Contract UI (Web)

This is a web migration of the macOS SwiftUI Deterministic Contract Lab.

## What this includes

- Deterministic contract experiment UI in browser
- Script picker + prompt count controls
- Provider selection and key handling (Together/OpenAI/Anthropic/Google/Mistral)
- Default Together model: `google/gemma-3n-e4b-it`
- Guardian Core observe/decide integration
- Assisted constraint proposal flow on PAUSE
- Export snapshot JSON
- Generate markdown lab report
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
- Keep API keys on server env vars only.
- Do not expose provider keys in client-side code.
