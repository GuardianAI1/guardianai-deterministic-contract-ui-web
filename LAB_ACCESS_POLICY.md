# GuardianAI Lab Access Policy (Production)

Last updated: February 26, 2026 (UTC)

## Purpose

This policy defines how partner labs can access GuardianAI production endpoints safely.

## Official Endpoints

- `POST https://guardianai.fr/core/observe`
- `POST https://guardianai.fr/gate/decide`

## Security Controls Enforced

- HTTPS-only access (HTTP is redirected).
- Authentication required on all `/core/*` and `/gate/*` routes.
- Accepted auth formats:
  - `X-Guardian-Key: <token>`
  - `Authorization: Bearer <token>`
- Origin controls for browser traffic:
  - Allowed origins: `https://app.guardianai.fr`, `https://guardianai.fr`, `https://www.guardianai.fr`
  - Other origins are rejected (`403`).
- API docs/spec endpoints disabled in production:
  - `/core/docs`, `/gate/docs`, `/core/openapi.json`, `/gate/openapi.json`
- Probe and secret-path blocking enabled (`.env`, `.git`, phpunit-style paths, etc.).
- Rate limits enabled:
  - Per IP: `20 req/s` (burst `30`)
  - Per token: `40 req/s` (burst `80`)
  - Probe traffic: `10 req/min` (additional throttling/blocking)

## Integration Modes

### 1) Server-to-Server (Recommended)

- Call endpoints from backend infrastructure.
- Do not expose Guardian tokens in frontend JavaScript.
- Share static egress IPs if possible for stronger allowlisting.

### 2) Browser-Based Lab UI

- Allowed only from approved origin domains.
- Must still send a valid Guardian token.
- Recommended pattern: browser -> lab backend -> GuardianAI (token stays server-side).

## Required Request Headers

- `Content-Type: application/json`
- `X-Guardian-Key: <token>` or `Authorization: Bearer <token>`

## Typical Response Codes

- `200` success
- `401` missing/invalid token
- `403` origin not allowed
- `404` disabled docs/spec routes
- `429` rate limit exceeded

## Partner Access Request Template

Provide all items below:

- Lab/organization name
- Integration mode: `server-to-server` or `browser-based`
- Business/experiment use case
- Required endpoints (`core`, `gate`, or both)
- Browser origin domain(s) (if browser-based)
- Static egress IP(s) (if server-to-server)
- Expected traffic profile (avg RPS, peak RPS)
- Technical contact (name + email)
- Desired start date

## Operational Rules

- Tokens are unique per partner and can be rotated/revoked at any time.
- Do not share tokens across labs.
- Excessive probing, abuse, or policy violations may trigger immediate revocation.
- Access rules (origins/IP/rate limits) are adjusted per partner risk profile.

