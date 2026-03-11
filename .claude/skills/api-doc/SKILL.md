---
name: api-doc
description: Document an API endpoint as a structured markdown file. Use this skill whenever the user pastes a cURL command and wants it saved, documented, or captured — even if they don't say "document". Trigger on phrases like "document this API", "save this endpoint", "add this API", "log this request", "capture this curl", or when the user pastes a cURL and asks to record or store it. Also trigger when the user says "create an API doc" or "I want to document this endpoint". The output is a structured .md file in ./apis/ that a Node.js server will later parse to power an API explorer UI.
---

# API Doc

Your job is to turn an API call into a well-structured markdown file that a Node.js server can later parse to build an API explorer/tester UI (think Postman, but custom).

## What you need from the user

1. **A cURL command** (required) — paste directly from browser DevTools or Postman
2. **A purpose** (optional) — a short hint like "creates an order" or "fetches user profile"
3. **A real response example** (required) — the actual JSON the API returned; you'll infer the schema from this

If the user hasn't provided the response example yet, ask for it before writing the file.

## Parsing the cURL

From the cURL, extract:
- HTTP method (`-X POST`, or GET if omitted)
- Full URL (including query params)
- Headers (`-H` flags) — separate auth headers from regular headers
- Request body (`-d` or `--data` flag) — parse as JSON if possible
- Auth type — Bearer token, API key, Basic auth, or None (infer from headers)

## Inferring the response schema

From the example JSON response:
- Walk every field and determine its type (`string`, `number`, `boolean`, `array`, `object`, `null`)
- For arrays, describe the item type
- Mark fields as **required** if they appear in every response (you can only tell from one example, so default to "yes" unless the user says otherwise)
- Write a brief description for each field based on its name and value — be specific, not generic. `"id": "ord_abc123"` → "Unique order identifier", not just "Identifier"
- For enum-like fields (status, type, role), list the observed values

## File naming

`./apis/<method>-<path-slug>.md` where path-slug is the URL path with slashes and colons replaced by hyphens.

Examples:
- `POST https://api.example.com/v1/orders` → `./apis/post-v1-orders.md`
- `GET https://api.example.com/users/:id/profile` → `./apis/get-users-id-profile.md`

Always create the `./apis/` directory if it doesn't exist.

## Output format

Write exactly this structure — keep section headers identical so the Node server can parse reliably:

```markdown
---
name: Human-readable name (e.g. "Create Order", "Get User Profile")
method: GET | POST | PUT | PATCH | DELETE
endpoint: https://full.url/with/path
auth: Bearer token | API key in header | Basic auth | None
tags: []
---

## Purpose
One clear sentence describing what this endpoint does and when you'd use it.

## Request

### Headers
| Header | Value |
|--------|-------|
| Authorization | Bearer {TOKEN} |
| Content-Type | application/json |

*(Omit this section if there are no headers beyond auth)*

### Body
```json
{
  "field": "value"
}
```
*(Omit this section for GET requests with no body)*

## Response

### Schema
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| id | string | yes | Unique order identifier |
| status | string | yes | Current state: "pending" \| "active" \| "cancelled" |

### Example
```json
{
  "id": "ord_abc123",
  "status": "pending"
}
```

## cURL
```bash
curl -X POST https://api.example.com/v1/orders \
  -H 'Authorization: Bearer TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"item": "widget", "qty": 3}'
```
```

**Important details:**
- Replace actual secret values (tokens, API keys) with `{TOKEN}`, `{API_KEY}`, etc. in the Headers table and cURL — but keep the structure intact
- For nested response objects, flatten one level with dot notation in the Schema table (e.g. `user.id`, `user.email`) or use a sub-table with a note
- The cURL at the bottom should be the original command (with secrets redacted), formatted for readability with line continuations `\`

After writing the file, tell the user the file path and give them a one-line summary of what was documented.
