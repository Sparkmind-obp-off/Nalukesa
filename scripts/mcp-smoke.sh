#!/usr/bin/env bash
# End-to-end MCP checks against a running LOCAL instance (wrangler pages dev + local D1).
# Usage: BASE=http://localhost:3000 PW=<local owner password> bash scripts/mcp-smoke.sh
# WARNING: creates fixture records and MCP tokens. Never point this at production.
set -u
BASE=${BASE:-http://localhost:3000}
PW=${PW:?set PW}
case "$BASE" in http://localhost*|http://127.0.0.1*) ;; *) echo "Refusing to run against non-local BASE=$BASE"; exit 2;; esac
JAR=$(mktemp); PASS=0; FAIL=0
H=(-H 'Content-Type: application/json' -H 'x-nk-client: web')
M=(-H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream')
check() { if [ "$2" == "$3" ]; then PASS=$((PASS+1)); echo "PASS  $1"; else FAIL=$((FAIL+1)); echo "FAIL  $1 (expected $2, got $3)"; fi; }
has()   { if grep -q -- "$2" /tmp/nk_body; then PASS=$((PASS+1)); echo "PASS  $1"; else FAIL=$((FAIL+1)); echo "FAIL  $1 (missing: $2)"; head -c 400 /tmp/nk_body; echo; fi; }
hasnt() { if grep -q -- "$2" /tmp/nk_body; then FAIL=$((FAIL+1)); echo "FAIL  $1 (found: $2)"; else PASS=$((PASS+1)); echo "PASS  $1"; fi; }
code() { curl -s -o /tmp/nk_body -w '%{http_code}' -b "$JAR" -c "$JAR" "$@"; }
idof() { sed -E 's/.*"id":([0-9]+).*/\1/' /tmp/nk_body; }
rpc()  { # token method params id
  code -X POST "${M[@]}" -H "Authorization: Bearer $1" -d "{\"jsonrpc\":\"2.0\",\"id\":$4,\"method\":\"$2\",\"params\":$3}" "$BASE/mcp"; }
call() { rpc "$1" tools/call "{\"name\":\"$2\",\"arguments\":$3}" 9; }

code -X POST "${H[@]}" -d "{\"password\":\"$PW\"}" "$BASE/api/auth/login" >/dev/null

# ---- fixtures (local DB only) ----
code -X POST "${H[@]}" -d '{"name":"MCP fixture niche","status":"Researching","confidence":"Low"}' "$BASE/api/niches" >/dev/null; NID=$(idof)
code -X POST "${H[@]}" -d '{"title":"Fixture listing page","source_type":"Platform listing","url":"https://shopee.co.id/fixture","accessed_at":"2026-10-20","evidence_grade":"B"}' "$BASE/api/evidence_sources" >/dev/null; SID=$(idof)
code -X POST "${H[@]}" -d "{\"name\":\"MCP fixture serum A\",\"niche_id\":$NID,\"platform\":\"Shopee\",\"listing_url\":\"https://shopee.co.id/fixture-a\",\"status\":\"Researching\"}" "$BASE/api/products" >/dev/null; PA=$(idof)
code -X POST "${H[@]}" -d "{\"name\":\"MCP fixture serum B\",\"niche_id\":$NID,\"platform\":\"Shopee\",\"listing_url\":\"https://shopee.co.id/fixture-b\",\"status\":\"Researching\"}" "$BASE/api/products" >/dev/null; PB=$(idof)
code -X POST "${H[@]}" -d "{\"product_id\":$PA,\"checked_at\":\"2026-10-20\",\"price_idr\":\"100000\",\"advertised_commission_pct\":\"10\"}" "$BASE/api/offer_snapshots" >/dev/null
code -X POST "${H[@]}" -d "{\"observed_fact\":\"Listing shows 4.8 rating\",\"source_id\":$SID,\"product_id\":$PA,\"observed_at\":\"2026-10-20\",\"interpretation\":\"Possibly well received\",\"confidence\":\"Low\"}" "$BASE/api/observations" >/dev/null
code -X POST "${H[@]}" -d "{\"title\":\"Fixture video\",\"product_id\":$PA,\"channel\":\"TikTok\",\"status\":\"Draft\",\"disclosure_status\":\"Not yet\",\"asset_rights\":\"Own original\"}" "$BASE/api/content_items" >/dev/null; CID=$(idof)
code -X POST "${H[@]}" -d "{\"content_item_id\":$CID,\"period_start\":\"2026-10-01\",\"period_end\":\"2026-10-07\",\"views\":\"1200\",\"clicks\":\"\",\"data_source\":\"fixture\"}" "$BASE/api/performance_snapshots" >/dev/null

# ---- token management (owner session) ----
check "unauth token create 401" 401 "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${H[@]}" -d '{}' "$BASE/api/mcp/tokens")"
check "invalid scope 400" 400 "$(code -X POST "${H[@]}" -d '{"name":"x","scopes":["admin"]}' "$BASE/api/mcp/tokens")"
check "create full token 201" 201 "$(code -X POST "${H[@]}" -d '{"name":"smoke-full","scopes":["products:read","evidence:read","performance:read","providers:read"],"ttl_days":1}' "$BASE/api/mcp/tokens")"
FULL=$(sed -E 's/.*"token":"([^"]+)".*/\1/' /tmp/nk_body); FULL_ID=$(sed -E 's/.*"record":\{"id":([0-9]+).*/\1/' /tmp/nk_body)
check "create limited token 201" 201 "$(code -X POST "${H[@]}" -d '{"name":"smoke-limited","scopes":["products:read"],"ttl_days":1}' "$BASE/api/mcp/tokens")"
LIM=$(sed -E 's/.*"token":"([^"]+)".*/\1/' /tmp/nk_body)
check "info 200" 200 "$(code "$BASE/api/mcp/info")"
hasnt "info never exposes token values" "$FULL"
hasnt "info never exposes hashes" "token_hash"

# ---- transport/auth ----
check "no bearer 401" 401 "$(code -X POST "${M[@]}" -d '{}' "$BASE/mcp")"
has  "WWW-Authenticate challenge body" "Bearer token required"
check "bad token 401" 401 "$(rpc nkmcp_notarealtoken_xxxxxxxx tools/list '{}' 1)"
check "owner session cookie is NOT accepted 401" 401 "$(code -X POST "${M[@]}" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' "$BASE/mcp")"
check "owner password as bearer 401" 401 "$(rpc "$PW" tools/list '{}' 1)"
check "cross-origin 403" 403 "$(code -X POST "${M[@]}" -H 'Origin: https://evil.example' -H "Authorization: Bearer $FULL" -d '{}' "$BASE/mcp")"
check "GET 405 (stateless)" 405 "$(code -H "Authorization: Bearer $FULL" "$BASE/mcp")"
check "malformed JSON 400" 400 "$(code -X POST "${M[@]}" -H "Authorization: Bearer $FULL" -d '{oops' "$BASE/mcp")"

# ---- protocol ----
check "initialize 200" 200 "$(rpc "$FULL" initialize '{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}' 1)"
has  "server name" '"name":"nalukesa"'
has  "negotiated protocol" '"protocolVersion":"2025-06-18"'
check "tools/list 200" 200 "$(rpc "$FULL" tools/list '{}' 2)"
for t in search_products get_product_evidence compare_opportunities get_affiliate_performance get_provider_status; do has "lists $t" "\"$t\""; done
has  "tools annotated read-only" '"readOnlyHint":true'

# ---- tools ----
call "$FULL" search_products '{"query":"MCP fixture serum"}' >/dev/null
has  "search finds fixture" "MCP fixture serum A"
has  "search reports total" '"total_matching":2'
call "$FULL" search_products '{"query":"zz-no-such-product-zz"}' >/dev/null
has  "empty search returns zero, no invention" '"returned":0'
call "$FULL" get_product_evidence "{\"product_id\":$PA}" >/dev/null
has  "evidence keeps source url" "https://shopee.co.id/fixture"
has  "evidence keeps grade" '"evidence_grade":"B"'
has  "evidence keeps interpretation separate" '"interpretation":"Possibly well received"'
has  "advertised commission caveat" "advertised rate only"
call "$FULL" get_product_evidence '{"product_id":999999}' >/dev/null
has  "missing product -> isError" '"isError":true'
call "$FULL" compare_opportunities "{\"product_ids\":[$PA,$PB]}" >/dev/null
has  "compare computes advertised per sale" '"advertised_commission_per_sale_idr":10000'
has  "compare lists missing fields for B" '"offer_snapshot"'
has  "compare states no score" "No score or ranking"
call "$FULL" get_affiliate_performance "{\"product_id\":$PA}" >/dev/null
has  "views recorded" '"views":1200'
has  "clicks unknown stays null" '"clicks":null'
has  "orders total null not zero" '"orders":{"sum":null'
call "$FULL" get_provider_status '{}' >/dev/null
has  "providers listed not_configured" '"config_status":"not_configured"'
hasnt "provider status leaks no secret values" "sk_"

# ---- validation & authorization ----
call "$FULL" search_products '{"limit":500}' >/dev/null
has  "invalid argument rejected" '"isError":true'
call "$FULL" compare_opportunities '{"product_ids":[1]}' >/dev/null
has  "min items enforced" '"isError":true'
call "$FULL" search_products '{"query":"x","sql":"DROP TABLE products"}' >/dev/null
check "unknown argument does not break anything (products table intact)" 200 "$(code "$BASE/api/products")"
call "$FULL" no_such_tool '{}' >/dev/null
has  "unknown tool -> error" "not found"
call "$LIM" get_product_evidence "{\"product_id\":$PA}" >/dev/null
has  "scope enforced (limited token)" "lacks scope"
call "$LIM" search_products '{}' >/dev/null
has  "limited token can use permitted tool" '"total_matching"'
rpc "$FULL" resources/list '{}' 3 >/dev/null
has  "no resources capability exposed" '"error"'

# ---- audit & revocation ----
code "$BASE/api/audit" >/dev/null
has  "MCP calls audited" "mcp_tool_call"
hasnt "audit has no token values" "$FULL"
check "revoke 200" 200 "$(code -X POST -H 'x-nk-client: web' "$BASE/api/mcp/tokens/$FULL_ID/revoke")"
check "revoked token 401" 401 "$(rpc "$FULL" tools/list '{}' 4)"

# ---- routing regression ----
check "SPA root 200" 200 "$(curl -s -o /tmp/nk_body -w '%{http_code}' "$BASE/")"
has  "SPA html served" '<div id="root">'
check "static favicon 200" 200 "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/favicon.svg")"
check "api health 200" 200 "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/health")"
check "/mcp/other not routed to MCP" 1 "$(curl -s "$BASE/mcp/other" | grep -c '<div id="root">')"

rm -f "$JAR"
echo "---- $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
