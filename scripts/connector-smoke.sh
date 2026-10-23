#!/usr/bin/env bash
# End-to-end tests for the GENERIC EXTERNAL MCP CONNECTOR.
# Requires: local wrangler (APP_ENV=development, CONNECTOR_ALLOW_LOCAL=true) + scripts/mock-mcp-server.mjs on :8788.
# Usage: PW=<local owner password> bash scripts/connector-smoke.sh
set -u
BASE=${BASE:-http://localhost:3000}
MOCK=${MOCK:-http://127.0.0.1:8788}
PW=${PW:?set PW}
case "$BASE" in http://localhost*|http://127.0.0.1*) ;; *) echo "Refusing non-local BASE"; exit 2;; esac
JAR=$(mktemp); PASS=0; FAIL=0
H=(-H 'Content-Type: application/json' -H 'x-nk-client: web')
M=(-H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream')
check() { if [ "$2" == "$3" ]; then PASS=$((PASS+1)); echo "PASS  $1"; else FAIL=$((FAIL+1)); echo "FAIL  $1 (expected $2, got $3)"; head -c 300 /tmp/nk_body; echo; fi; }
has()   { if grep -q -- "$2" /tmp/nk_body; then PASS=$((PASS+1)); echo "PASS  $1"; else FAIL=$((FAIL+1)); echo "FAIL  $1 (missing: $2)"; head -c 500 /tmp/nk_body; echo; fi; }
hasnt() { if grep -q -- "$2" /tmp/nk_body; then FAIL=$((FAIL+1)); echo "FAIL  $1 (found: $2)"; else PASS=$((PASS+1)); echo "PASS  $1"; fi; }
code() { curl -s -o /tmp/nk_body -w '%{http_code}' -b "$JAR" -c "$JAR" "$@"; }
jget() { node -e "const d=JSON.parse(require('fs').readFileSync('/tmp/nk_body','utf8'));const v=$1;console.log(v===undefined?'':typeof v==='object'?JSON.stringify(v):v)"; }
C=$BASE/api/connector

# ---- 16. unauthorized callers ----
check "unauth list connections 401" 401 "$(curl -s -o /tmp/nk_body -w '%{http_code}' $C/connections)"
check "unauth create 401" 401 "$(curl -s -o /tmp/nk_body -w '%{http_code}' -X POST "${H[@]}" -d '{}' $C/connections)"
check "unauth invoke 401" 401 "$(curl -s -o /tmp/nk_body -w '%{http_code}' -X POST "${H[@]}" -d '{}' $C/connections/1/tools/x/invoke)"
code -X POST "${H[@]}" -d "{\"password\":\"$PW\"}" "$BASE/api/auth/login" >/dev/null
check "write without CSRF header 403" 403 "$(code -X POST -H 'Content-Type: application/json' -d '{}' $C/connections)"

check "meta 200" 200 "$(code $C/meta)"
has  "meta: encryption configured" '"encryption_configured":true'
has  "meta: stdio marked unsupported" '"supported":false'

# ---- 2. unsafe endpoints rejected at registration ----
for u in "http://example.com/mcp" "https://127.0.0.1/mcp" "https://169.254.169.254/" "https://localhost/mcp" "https://10.0.0.1/" "https://svc.internal/mcp" "https://nalukesa.biz.id/mcp" "https://u:p@mcp.example.com/" "https://mcp.example.com:8443/" "http://127.0.0.2:8788/mcp" "ftp://x.example/"; do
  check "reject endpoint $u" 400 "$(code -X POST "${H[@]}" -d "{\"name\":\"bad\",\"endpoint_url\":\"$u\",\"auth_type\":\"none\"}" $C/connections)"
done
check "reject unknown field (mass assignment)" 400 "$(code -X POST "${H[@]}" -d "{\"name\":\"x\",\"endpoint_url\":\"$MOCK/mcp\",\"auth_type\":\"none\",\"owner\":\"attacker\"}" $C/connections)"
check "bearer requires token" 400 "$(code -X POST "${H[@]}" -d "{\"name\":\"x\",\"endpoint_url\":\"$MOCK/mcp\",\"auth_type\":\"bearer\"}" $C/connections)"

# ---- 1. register generic connection (bearer) ----
check "register connection 201" 201 "$(code -X POST "${H[@]}" -d "{\"name\":\"Mock provider\",\"endpoint_url\":\"$MOCK/mcp\",\"auth_type\":\"bearer\",\"bearer_token\":\"mock-good-token\",\"timeout_ms\":3000,\"max_response_bytes\":65536}" $C/connections)"
CID=$(jget 'd.id')
hasnt "response never echoes bearer token" "mock-good-token"
hasnt "response never includes ciphertext" "auth_ciphertext"
has  "credential hint only" '"auth_hint":"…oken"'
check "list 200" 200 "$(code $C/connections)"
has  "readiness untested" '"readiness":"untested"'
hasnt "list never leaks token" "mock-good-token"

# ---- 9 (pre). invoke before test is blocked ----
check "invoke before test blocked 403" 403 "$(code -X POST "${H[@]}" -d '{"arguments":{}}' $C/connections/$CID/tools/get_weather/invoke)"

# ---- 3/5/6. authenticate, initialize, discover ----
check "test connection 200" 200 "$(code -X POST -H 'x-nk-client: web' $C/connections/$CID/test)"
has  "test ok" '"ok":true'
has  "server name from initialize" '"serverName":"mock-provider"'
has  "protocol negotiated" '"protocolVersion":"20'
has  "tools discovered" '"tools_discovered":7'
check "detail 200" 200 "$(code $C/connections/$CID)"
has  "readiness tools_discovered (not ready)" '"readiness":"tools_discovered"'
has  "input schema exposed" '"minLength":2'
has  "read risk from readOnlyHint" '"risk":"read"'
has  "write risk when hints absent" '"risk":"write"'
has  "destructive risk" '"risk":"destructive"'
has  "all tools denied by default" '"permission":"denied"'
hasnt "no tool allowed by default" '"permission":"allowed"'

# ---- 8. non-allowlisted tool rejected ----
check "invoke denied tool 403" 403 "$(code -X POST "${H[@]}" -d '{"arguments":{"city":"Jakarta"}}' $C/connections/$CID/tools/get_weather/invoke)"
has  "reason not_allowed" '"not_allowed"'
check "invoke unknown tool 403" 403 "$(code -X POST "${H[@]}" -d '{}' $C/connections/$CID/tools/no_such_tool/invoke)"

# ---- 7. approve / deny ----
check "approve read tool 200" 200 "$(code -X PUT "${H[@]}" -d '{"permission":"allowed"}' $C/connections/$CID/tools/get_weather/permission)"
check "approve write tool without confirm 400" 400 "$(code -X PUT "${H[@]}" -d '{"permission":"allowed"}' $C/connections/$CID/tools/create_note/permission)"
check "approve destructive with wrong confirm 400" 400 "$(code -X PUT "${H[@]}" -d '{"permission":"allowed","confirm_risk":"write"}' $C/connections/$CID/tools/delete_all/permission)"
check "approve write with explicit confirm 200" 200 "$(code -X PUT "${H[@]}" -d '{"permission":"allowed","confirm_risk":"write"}' $C/connections/$CID/tools/create_note/permission)"
check "invalid permission value 400" 400 "$(code -X PUT "${H[@]}" -d '{"permission":"maybe"}' $C/connections/$CID/tools/get_weather/permission)"
for t in echo_auth slow_tool big_tool failing_tool; do code -X PUT "${H[@]}" -d '{"permission":"allowed"}' $C/connections/$CID/tools/$t/permission >/dev/null; done

# ---- 9. invoke approved tool, real mock result ----
check "invoke approved tool 200" 200 "$(code -X POST "${H[@]}" -d '{"arguments":{"city":"Jakarta","units":"c"}}' $C/connections/$CID/tools/get_weather/invoke)"
has  "real structured result" '"temp":25'
has  "real text result" 'Weather in Jakarta'
has  "provenance marked untrusted" '"untrusted":true'
has  "provenance server" '"server_name":"mock-provider"'
check "readiness ready after verified call" 200 "$(code $C/connections/$CID)"
has  "status verified" '"status":"verified"'
has  "readiness ready" '"readiness":"ready"'
check "write tool after explicit approval 200" 200 "$(code -X POST "${H[@]}" -d '{"arguments":{"text":"hello"}}' $C/connections/$CID/tools/create_note/invoke)"
has  "write tool result" 'created: hello'
check "deny again 200" 200 "$(code -X PUT "${H[@]}" -d '{"permission":"denied"}' $C/connections/$CID/tools/create_note/permission)"
check "denied tool blocked again 403" 403 "$(code -X POST "${H[@]}" -d '{"arguments":{"text":"x"}}' $C/connections/$CID/tools/create_note/invoke)"

# ---- 10. argument validation against discovered schema ----
check "missing required arg 400" 400 "$(code -X POST "${H[@]}" -d '{"arguments":{}}' $C/connections/$CID/tools/get_weather/invoke)"
has  "schema error details" '"invalid_arguments"'
check "enum violation 400" 400 "$(code -X POST "${H[@]}" -d '{"arguments":{"city":"Jakarta","units":"kelvin"}}' $C/connections/$CID/tools/get_weather/invoke)"
check "array args rejected 400" 400 "$(code -X POST "${H[@]}" -d '{"arguments":[1,2]}' $C/connections/$CID/tools/get_weather/invoke)"
BIGARG=$(head -c 34000 /dev/zero | tr '\0' 'a')
check "oversized args rejected" 400 "$(code -X POST "${H[@]}" -d "{\"arguments\":{\"city\":\"$BIGARG\"}}" $C/connections/$CID/tools/get_weather/invoke)"

# ---- tool-level error ----
check "remote tool error surfaced 200" 200 "$(code -X POST "${H[@]}" -d '{"arguments":{}}' $C/connections/$CID/tools/failing_tool/invoke)"
has  "status tool_error" '"status":"tool_error"'

# ---- 15. hostile reflection of credential is redacted ----
code -X POST "${H[@]}" -d '{"arguments":{}}' $C/connections/$CID/tools/echo_auth/invoke >/dev/null
hasnt "reflected bearer redacted" "mock-good-token"
has  "redaction marker present" 'REDACTED'

# ---- 12. response size limit (chunk/declared handled by guardedFetch unit tests too) ----
check "oversized tool result 502" 502 "$(code -X POST "${H[@]}" -d '{"arguments":{"kb":200}}' $C/connections/$CID/tools/big_tool/invoke)"
has  "status invalid_response" '"status":"invalid_response"'

# ---- 13. timeout during tool execution ----
check "slow tool times out 502" 502 "$(code -X POST "${H[@]}" -d '{"arguments":{"ms":8000}}' $C/connections/$CID/tools/slow_tool/invoke)"
has  "status timeout" '"status":"timeout"'

# ---- 4. invalid credentials ----
check "rotate to bad token 200" 200 "$(code -X PATCH "${H[@]}" -d '{"bearer_token":"wrong-token-123"}' $C/connections/$CID)"
has  "status reset to untested after credential change" '"status":"untested"'
code -X POST -H 'x-nk-client: web' $C/connections/$CID/test >/dev/null
has  "bad credential -> not ok" '"ok":false'
has  "auth_required/failed kind" '"kind":"auth_'
hasnt "error never leaks token" "wrong-token-123"
check "invoke with bad cred blocked 403" 403 "$(code -X POST "${H[@]}" -d '{"arguments":{"city":"Jakarta"}}' $C/connections/$CID/tools/get_weather/invoke)"
code -X PATCH "${H[@]}" -d '{"bearer_token":"mock-good-token"}' $C/connections/$CID >/dev/null
code -X POST -H 'x-nk-client: web' $C/connections/$CID/test >/dev/null
has  "restored credential works" '"ok":true'

# ---- catalog refresh: changed catalog detected ----
curl -s "$MOCK/admin/variant?v=v2" >/dev/null
code -X POST -H 'x-nk-client: web' $C/connections/$CID/test >/dev/null
has  "new tool detected on refresh" '"added":\["new_tool"\]'
code $C/connections/$CID >/dev/null
has  "new tool denied by default" '"name":"new_tool"'
curl -s "$MOCK/admin/variant?v=v1" >/dev/null
code -X POST -H 'x-nk-client: web' $C/connections/$CID/test >/dev/null
has  "removed tool detected" '"removed":\["new_tool"\]'
check "approve vanished tool 409" 409 "$(code -X PUT "${H[@]}" -d '{"permission":"allowed"}' $C/connections/$CID/tools/new_tool/permission)"

# ---- 11. malformed protocol ----
code -X POST "${H[@]}" -d "{\"name\":\"Malformed\",\"endpoint_url\":\"$MOCK/malformed\",\"auth_type\":\"none\"}" $C/connections >/dev/null; MID=$(jget 'd.id')
code -X POST -H 'x-nk-client: web' $C/connections/$MID/test >/dev/null
has  "malformed -> not ok" '"ok":false'
has  "malformed classified" '"kind":"invalid_response"'

# ---- 14. redirect rejected ----
code -X POST "${H[@]}" -d "{\"name\":\"Redirector\",\"endpoint_url\":\"$MOCK/redirect\",\"auth_type\":\"none\"}" $C/connections >/dev/null; RID=$(jget 'd.id')
code -X POST -H 'x-nk-client: web' $C/connections/$RID/test >/dev/null
has  "redirect blocked" '"kind":"blocked"'

# ---- 19. OAuth 2.1 (discovery + DCR + PKCE + state + exchange + refresh) ----
code -X POST "${H[@]}" -d "{\"name\":\"OAuth mock\",\"endpoint_url\":\"$MOCK/mcp-oauth\",\"auth_type\":\"oauth\"}" $C/connections >/dev/null; OID=$(jget 'd.id')
code $C/connections/$OID >/dev/null
has  "oauth readiness auth_required" '"readiness":"auth_required"'
check "oauth start 200" 200 "$(code -X POST -H 'x-nk-client: web' $C/connections/$OID/oauth/start)"
AUTHURL=$(jget 'd.authorization_url')
case "$AUTHURL" in *code_challenge_method=S256*state=*|*state=*code_challenge_method=S256*) PASS=$((PASS+1)); echo "PASS  authorization URL has PKCE S256 + state";; *) FAIL=$((FAIL+1)); echo "FAIL  authorization URL: $AUTHURL";; esac
REDIR=$(curl -s "$AUTHURL" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).redirect))")
STATE=$(node -e "console.log(new URL(process.argv[1]).searchParams.get('state'))" "$REDIR")
CODEP=$(node -e "console.log(new URL(process.argv[1]).searchParams.get('code'))" "$REDIR")
check "callback without session 401" 401 "$(curl -s -o /tmp/nk_body -w '%{http_code}' "$BASE/api/connector/oauth/callback?code=$CODEP&state=$STATE")"
check "callback with forged state 400" 400 "$(code "$BASE/api/connector/oauth/callback?code=$CODEP&state=forged-state")"
check "callback valid 200" 200 "$(code "$BASE/api/connector/oauth/callback?code=$CODEP&state=$STATE")"
has  "authorization complete page" "Authorization complete"
check "state replay rejected 400" 400 "$(code "$BASE/api/connector/oauth/callback?code=$CODEP&state=$STATE")"
sleep 3   # access token (2s lifetime) expires → refresh path
code -X POST -H 'x-nk-client: web' $C/connections/$OID/test >/dev/null
has  "oauth test ok after automatic refresh" '"ok":true'
code -X PUT "${H[@]}" -d '{"permission":"allowed"}' $C/connections/$OID/tools/get_weather/permission >/dev/null
check "oauth invoke 200" 200 "$(code -X POST "${H[@]}" -d '{"arguments":{"city":"Bandung"}}' $C/connections/$OID/tools/get_weather/invoke)"
has  "oauth real result" 'Weather in Bandung'
code $C/connections/$OID/audit >/dev/null
has  "oauth refresh audited" 'connector_oauth_refresh'
hasnt "audit has no tokens" 'oat_'

# ---- 17. inbound MCP still works + bridge ----
code -X POST "${H[@]}" -d '{"name":"bridge","scopes":["products:read","connectors:read","connectors:invoke"],"ttl_days":1}' "$BASE/api/mcp/tokens" >/dev/null
TOK=$(jget 'd.token')
rpc() { code -X POST "${M[@]}" -H "Authorization: Bearer $TOK" -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}" "$BASE/mcp"; }
check "inbound initialize 200" 200 "$(rpc initialize '{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}')"
rpc tools/list '{}' >/dev/null
has  "inbound lists bridge tool" '"call_external_tool"'
has  "inbound still lists search_products" '"search_products"'
rpc tools/call '{"name":"list_external_connections","arguments":{}}' >/dev/null
has  "bridge lists connections" 'Mock provider'
hasnt "bridge never leaks credentials" 'mock-good-token'
rpc tools/call "{\"name\":\"call_external_tool\",\"arguments\":{\"connection_id\":$CID,\"tool\":\"get_weather\",\"arguments\":{\"city\":\"Medan\"}}}" >/dev/null
has  "bridge invokes approved read tool" 'Weather in Medan'
has  "bridge marks third-party content untrusted" 'untrusted'
code -X PUT "${H[@]}" -d '{"permission":"allowed","confirm_risk":"write"}' $C/connections/$CID/tools/create_note/permission >/dev/null
rpc tools/call "{\"name\":\"call_external_tool\",\"arguments\":{\"connection_id\":$CID,\"tool\":\"create_note\",\"arguments\":{\"text\":\"x\"}}}" >/dev/null
has  "bridge refuses write tools" 'Only read-only external tools'
rpc tools/call "{\"name\":\"call_external_tool\",\"arguments\":{\"connection_id\":$CID,\"tool\":\"delete_all\",\"arguments\":{}}}" >/dev/null
has  "bridge refuses non-approved tool" 'not approved'
check "recursive hop refused 403" 403 "$(code -X POST "${M[@]}" -H "Authorization: Bearer $TOK" -H 'X-NK-Hop: 1' -d '{}' "$BASE/mcp")"

# ---- 18. persistence, edit, disable, revoke, delete ----
check "edit name 200" 200 "$(code -X PATCH "${H[@]}" -d '{"name":"Mock provider (renamed)"}' $C/connections/$CID)"
has  "rename persisted" 'Mock provider (renamed)'
check "disable 200" 200 "$(code -X PATCH "${H[@]}" -d '{"enabled":false}' $C/connections/$CID)"
check "invoke disabled 403" 403 "$(code -X POST "${H[@]}" -d '{"arguments":{"city":"Jakarta"}}' $C/connections/$CID/tools/get_weather/invoke)"
check "test disabled 409" 409 "$(code -X POST -H 'x-nk-client: web' $C/connections/$CID/test)"
code -X PATCH "${H[@]}" -d '{"enabled":true}' $C/connections/$CID >/dev/null
check "change endpoint resets permissions" 200 "$(code -X PATCH "${H[@]}" -d "{\"endpoint_url\":\"$MOCK/mcp-open\",\"auth_type\":\"none\"}" $C/connections/$CID)"
has  "credential dropped on endpoint change" '"has_credential":false'
code $C/connections/$CID >/dev/null
hasnt "all permissions reset after endpoint change" '"permission":"allowed"'
check "revoke credential 200" 200 "$(code -X POST -H 'x-nk-client: web' $C/connections/$OID/revoke-credential)"
has  "revoked has no credential" '"has_credential":false'
check "invocation history 200" 200 "$(code $C/connections/$OID/invocations)"
has  "invocations recorded" '"status":"success"'
hasnt "invocation log has no secrets" 'oat_'
check "delete 200" 200 "$(code -X DELETE -H 'x-nk-client: web' $C/connections/$MID)"
check "deleted is 404" 404 "$(code $C/connections/$MID)"
check "global invocation log 200" 200 "$(code $C/invocations)"

# ---- regression: routing ----
check "SPA 200" 200 "$(curl -s -o /dev/null -w '%{http_code}' $BASE/)"
check "health 200" 200 "$(curl -s -o /dev/null -w '%{http_code}' $BASE/api/health)"

rm -f "$JAR"
echo "---- $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
