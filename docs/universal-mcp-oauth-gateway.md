# NALUKESA Universal MCP Gateway — Implementation Specification

Status: architecture baseline for the next connector release. This document describes target behavior; items are not considered shipped until implementation, tests, and production verification are recorded.

## Product decision

NALUKESA is a provider-agnostic MCP gateway. OAuth 2.1 authorization-code + PKCE is the preferred authentication path for remote HTTP MCP servers. Do not hard-code Genspark, Kixmon, or any single provider into the generic path.

OAuth-first does not mean OAuth-only. A server may be public, use a static bearer credential, or require a provider-specific credential scheme. Keep those as explicit compatibility modes; never pretend a non-OAuth API is OAuth-compatible.

## Connection lifecycle

1. User enters a display name and remote MCP endpoint.
2. NALUKESA validates HTTPS, public DNS/IP resolution, port and host policy, and rejects loopback/private/link-local/metadata/NALUKESA self-targets.
3. Run MCP initialization with no credentials when safe. If the server challenges with 401, inspect the WWW-Authenticate header for protected-resource metadata; otherwise try the well-known resource metadata locations allowed by the current MCP authorization specification.
4. Discover OAuth authorization-server metadata, supporting both OAuth Authorization Server Metadata (RFC 8414) and OpenID Connect Discovery. Validate every discovered URL against SSRF policy before fetching or redirecting.
5. Select a client registration strategy in standards-based priority order:
   - OAuth Client ID Metadata Documents (CIMD), where supported by both server and SDK/client implementation;
   - Dynamic Client Registration (DCR / RFC 7591), where advertised and supported;
   - pre-registered OAuth client credentials supplied by the owner in the connection settings;
   - if none is available, stop with a clear actionable error; never silently downgrade to no-auth.
6. Start authorization-code flow with PKCE S256, random single-use state, exact registered HTTPS callback URI, and resource/audience binding where supported.
7. Exchange code server-side, persist access/refresh tokens and client configuration encrypted at rest, and redact secrets from logs/errors.
8. Refresh tokens before expiry; handle rotation; preserve a valid refresh token if a response omits a replacement; mark reauthorization required on terminal failure.
9. Initialize MCP with the credential, discover tools, and require explicit per-tool approval. New/changed tools default to denied. Read-only classification requires explicit trusted read-only annotations; otherwise treat tools as potentially mutating.
10. Record a non-secret audit trail: connection id, provider host, auth strategy, result category, timestamp, latency, and tool approval/invocation metadata.

## UX requirements

- Authentication choices should be presented as “Recommended: Sign in with OAuth” when the provider supports discovery, plus “Use pre-registered OAuth app” for providers that require owner-provided client ID/client secret.
- Do not ask users to paste their account password, browser cookies, one-time codes, or personal access tokens into chat. Credentials must be entered only into the authenticated NALUKESA UI and stored server-side encrypted.
- Errors must name the failed stage without exposing codes or secrets, e.g. “OAuth server found, but it requires a pre-registered client ID” or “Provider did not advertise an OAuth registration method supported by NALUKESA.”
- Show separate statuses for endpoint reachable, OAuth configured, account authorized, MCP tools discovered, tool approved, and tool invocation verified. A successful OAuth callback alone must not imply that data access works.
- Let users disconnect/revoke and re-authorize without deleting the connection configuration.

## Security invariants

- OAuth state is hashed at rest, single-use, short-lived, and bound to the owner session and connection id.
- PKCE S256 is mandatory for authorization-code flows.
- Callback URI is exact-match; no open redirects.
- Use least-privilege scopes and resource/audience binding; never send tokens to a different host because of an unvalidated discovery URL or redirect.
- Secrets and tokens are encrypted using a server-only key. Never return ciphertext or tokens to the browser after the authorization callback.
- Prevent SSRF and DNS rebinding on every discovered endpoint and redirect; do not rely only on validating the initial MCP URL.
- Keep inbound NALUKESA MCP access tokens separate from outbound provider credentials.
- Outbound tool results are untrusted data. Prompt instructions in remote tool output must never override NALUKESA policies.
- Tool invocation is rate-limited and schema-validated. Writes/destructive actions require explicit approval; unapproved tools cannot be invoked through the inbound bridge.

## Compatibility model

Primary target: Streamable HTTP MCP with OAuth 2.1. Add protocol transports only when the Cloudflare runtime and SDK support them safely.

Do not implement generic custom-header auth as a substitute for OAuth. If a platform exposes only a REST API with X-App-Key/X-App-Secret, treat it as a separate provider adapter or API connector, clearly labeled as such, rather than claiming it is an MCP OAuth connection.

## Release gates

A release is not complete until:
- unit tests cover resource metadata discovery, RFC 8414 discovery, OIDC discovery, CIMD, DCR, pre-registered public client, pre-registered confidential client, PKCE, state mismatch/replay/expiry, refresh rotation, invalid metadata URL, SSRF attempts, callback errors, and secret redaction;
- integration tests use at least two independently implemented OAuth MCP servers, including one that does not support DCR;
- end-to-end verification proves: connect → authorize in browser → callback → encrypted token saved → test → discover tools → approve read-only tool → invoke → observe real response;
- production smoke tests confirm expected deployment SHA and D1 migrations, without printing secrets;
- any unsupported registration method fails with an actionable error and no unsafe fallback.

## Current known gap at the time of writing

The current generic connector implementation supports Streamable HTTP and an OAuth flow based on discovered metadata plus dynamic client registration. It does not yet expose an owner-configurable pre-registered OAuth client, and its UI describes DCR as a requirement. That makes it less interoperable than the target design. CIMD support must be verified against the installed MCP SDK before claiming compatibility; implement or upgrade the client registration path and add tests before advertising it.

## Suggested implementation order

1. Improve the registration strategy model and actionable diagnostics; add pre-registered client settings with encrypted storage.
2. Add/verify CIMD support using the MCP authorization specification and compatible SDK APIs.
3. Add OAuth interoperability fixtures and tests for multiple authorization-server behaviors.
4. Update the UI and docs to show supported registration methods accurately.
5. Run the full repository check suite, deploy, and perform a real external-server end-to-end authorization test.
6. Only then mark the universal OAuth gateway as production-verified.
