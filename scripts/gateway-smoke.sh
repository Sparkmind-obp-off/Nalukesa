#!/usr/bin/env bash
# Universal MCP Gateway — OAuth interoperability end-to-end tests (LOCAL ONLY).
# Three independently-behaving authorization servers in scripts/mock-mcp-server.mjs:
#   as-dcr (RFC 8414 + DCR + rotation), as-cimd (OIDC discovery + CIMD only), as-prereg (no DCR/CIMD; confidential pre-registered client)
# Usage: PW=<local owner password> bash scripts/gateway-smoke.sh
set -u
BASE=${BASE:-http://localhost:3000}
MOCK=${MOCK:-http://127.0.0.1:8788}
PW=${PW:?set PW}
case "$BASE" in http://localhost*|http://127.0.0.1*) ;; *) echo "Refusing non-local BASE"; exit 2;; esac
JAR=$(mktemp); JAR2=$(mktemp); PASS=0; FAIL=0
H=(-H 'Content-Type: application/json' -H 'x-nk-client: web')
C=$BASE/api/connector
check() { if [ "$2" == "$3" ]; then PASS=$((PASS+1)); echo "PASS  $1"; else FAIL=$((FAIL+1)); echo "FAIL  $1 (expected $2, got $3)"; head -c 400 /tmp/gw_body; echo; fi; }
has()   { if grep -q -- "$2" /tmp/gw_body; then PASS=$((PASS+1)); echo "PASS  $1"; else FAIL=$((FAIL+1)); echo "FAIL  $1 (missing: $2)"; head -c 600 /tmp/gw_body; echo; fi; }
hasnt() { if grep -q -- "$2" /tmp/gw_body; then FAIL=$((FAIL+1)); echo "FAIL  $1 (found: $2)"; else PASS=$((PASS+1)); echo "PASS  $1"; fi; }
code()  { curl -s -o /tmp/gw_body -w '%{http_code}' -b "$JAR" -c "$JAR" "$@"; }
jget()  { node -e "const d=JSON.parse(require('fs').readFileSync('/tmp/gw_body','utf8'));const v=$1;console.log(v===undefined||v===null?'':typeof v==='object'?JSON.stringify(v):v)"; }
qp()    { node -e "console.log(new URL(process.argv[1]).searchParams.get(process.argv[2])??'')" "$1" "$2"; }
login() { curl -s -o /dev/null -b "$1" -c "$1" -X POST "${H[@]}" -d "{\"password\":\"$PW\"}" "$BASE/api/auth/login"; }
# drive the mock authorization endpoint (auto-approves) and return the redirect back to NALUKESA
authorize() { curl -s "$1" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log(j.redirect??('ERR:'+(j.error||s)))}catch{console.log('ERR:'+s)}})"; }
callback() { local r="$1"; curl -s -o /tmp/gw_body -w '%{http_code}' -b "${2:-$JAR}" -c "${2:-$JAR}" "$BASE/api/connector/oauth/callback?$(node -e "console.log(new URL(process.argv[1]).search.slice(1))" "$r")"; }
create() { code -X POST "${H[@]}" -d "$1" $C/connections >/dev/null; jget 'd.id'; }

login "$JAR"
code $C/meta >/dev/null
has  "meta lists CIMD strategy" '"id":"cimd"'
has  "meta lists DCR strategy" '"id":"dcr"'
has  "meta lists pre-registered strategy" '"id":"preregistered"'
has  "meta PKCE S256 mandatory" 'S256 (mandatory)'
has  "meta exposes exact redirect_uri" '/api/connector/oauth/callback'
check "CIMD document served" 200 "$(curl -s -o /tmp/gw_body -w '%{http_code}' $BASE/oauth/client-metadata.json)"
has  "CIMD client_id == document URL" "\"client_id\":\"$BASE/oauth/client-metadata.json\""
has  "CIMD public client" '"token_endpoint_auth_method":"none"'
hasnt "CIMD has no secrets" 'secret'

########## 1) DCR provider (RFC 8414) — full lifecycle + refresh rotation ##########
DCR=$(create "{\"name\":\"GW DCR\",\"endpoint_url\":\"$MOCK/mcp-oauth\",\"auth_type\":\"oauth\"}")
check "diagnose DCR 200" 200 "$(code -X POST -H 'x-nk-client: web' $C/connections/$DCR/oauth/diagnose)"
has  "PRM discovered via WWW-Authenticate" '"source":"www-authenticate"'
has  "AS discovered (RFC 8414)" '"discovery":"oauth"'
has  "DCR advertised" '"dcr":true'
has  "strategy dcr selected" '"selected":"dcr"'
has  "PKCE S256 supported" '"pkce_s256":true'
check "start DCR 200" 200 "$(code -X POST -H 'x-nk-client: web' $C/connections/$DCR/oauth/start)"
AU=$(jget 'd.authorization_url')
[ "$(qp "$AU" code_challenge_method)" == "S256" ] && { PASS=$((PASS+1)); echo "PASS  PKCE S256 in authorization URL"; } || { FAIL=$((FAIL+1)); echo "FAIL  PKCE S256"; }
[ ${#AU} -gt 0 ] && [ "$(qp "$AU" resource)" == "$MOCK/mcp-oauth" ] && { PASS=$((PASS+1)); echo "PASS  RFC 8707 resource bound to endpoint"; } || { FAIL=$((FAIL+1)); echo "FAIL  resource indicator: $(qp "$AU" resource)"; }
[ "$(qp "$AU" redirect_uri)" == "$BASE/api/connector/oauth/callback" ] && { PASS=$((PASS+1)); echo "PASS  exact redirect_uri"; } || { FAIL=$((FAIL+1)); echo "FAIL  redirect_uri"; }
ST=$(qp "$AU" state); [ ${#ST} -ge 40 ] && { PASS=$((PASS+1)); echo "PASS  state is high-entropy (${#ST} chars)"; } || { FAIL=$((FAIL+1)); echo "FAIL  state length"; }
R=$(authorize "$AU")
# state bound to owner session: a different (logged-in) session cannot complete it
login "$JAR2"
check "callback from OTHER owner session rejected" 400 "$(callback "$R" "$JAR2")"
check "callback without session 401" 401 "$(curl -s -o /tmp/gw_body -w '%{http_code}' "$BASE/api/connector/oauth/callback?$(node -e "console.log(new URL(process.argv[1]).search.slice(1))" "$R")")"
# the other-session attempt consumed nothing? (single-use only consumed on match) → original session still works
check "callback valid 200" 200 "$(callback "$R")"
has  "authorization-complete page warns it is not proof of access" 'does not prove data access'
check "state replay rejected 400" 400 "$(callback "$R")"
code $C/connections/$DCR >/dev/null
has  "strategy recorded dcr" '"oauth_strategy":"dcr"'
has  "stage account_authorized ok" '"account_authorized":"ok"'
has  "stage invocation not yet verified" '"invocation_verified":"unknown"'
hasnt "no tokens in API response" 'oat_'
hasnt "no refresh tokens in API response" 'ort_'
hasnt "no ciphertext in API response" 'v1\.'
has  "readiness untested after callback" '"readiness":"untested"'
sleep 3   # 2s access token expires → refresh with rotation
check "test after expiry (auto refresh) 200" 200 "$(code -X POST -H 'x-nk-client: web' $C/connections/$DCR/test)"
has  "test ok" '"ok":true'
code $C/connections/$DCR/audit >/dev/null
has  "refresh audited with rotation" 'rotated\\":true'
curl -s "$MOCK/admin/oauth-stats" > /tmp/gw_body
has  "provider observed a rotation" '"rotations":[1-9]'
code -X PUT "${H[@]}" -d '{"permission":"allowed"}' $C/connections/$DCR/tools/get_weather/permission >/dev/null
check "invoke via DCR 200" 200 "$(code -X POST "${H[@]}" -d '{"arguments":{"city":"Malang"}}' $C/connections/$DCR/tools/get_weather/invoke)"
has  "real result via DCR" 'Weather in Malang'
code $C/connections/$DCR >/dev/null
has  "DCR connection ready" '"readiness":"ready"'
has  "stage invocation verified" '"invocation_verified":"ok"'
# DCR registration is cached (encrypted) and reused on re-authorization
code -X POST -H 'x-nk-client: web' $C/connections/$DCR/oauth/start >/dev/null; CID1=$(qp "$(jget 'd.authorization_url')" client_id)
code -X POST -H 'x-nk-client: web' $C/connections/$DCR/oauth/start >/dev/null; CID2=$(qp "$(jget 'd.authorization_url')" client_id)
check "DCR client reused across re-authorization" "$CID1" "$CID2"
# callback error from provider
AU=$(jget 'd.authorization_url'); R=$(authorize "${AU}&simulate_error=1")
check "provider error callback 400" 400 "$(callback "$R")"
has  "provider error surfaced safely" 'access_denied'

########## 2) CIMD provider (OIDC discovery, no DCR) ##########
CIMD=$(create "{\"name\":\"GW CIMD\",\"endpoint_url\":\"$MOCK/mcp-cimd\",\"auth_type\":\"oauth\"}")
code -X POST -H 'x-nk-client: web' $C/connections/$CIMD/oauth/diagnose >/dev/null
has  "OIDC discovery used" '"discovery":"oidc"'
has  "CIMD advertised" '"cimd":true'
has  "no DCR on CIMD server" '"dcr":false'
has  "strategy cimd selected" '"selected":"cimd"'
code -X POST -H 'x-nk-client: web' $C/connections/$CIMD/oauth/start >/dev/null; AU=$(jget 'd.authorization_url')
check "CIMD client_id is metadata URL" "$BASE/oauth/client-metadata.json" "$(qp "$AU" client_id)"
R=$(authorize "$AU"); case "$R" in ERR:*) echo "authorize error: $R";; esac
check "CIMD callback 200" 200 "$(callback "$R")"
code -X POST -H 'x-nk-client: web' $C/connections/$CIMD/test >/dev/null; has "CIMD test ok" '"ok":true'
code -X PUT "${H[@]}" -d '{"permission":"allowed"}' $C/connections/$CIMD/tools/get_weather/permission >/dev/null
check "invoke via CIMD 200" 200 "$(code -X POST "${H[@]}" -d '{"arguments":{"city":"Solo"}}' $C/connections/$CIMD/tools/get_weather/invoke)"
has  "real result via CIMD" 'Weather in Solo'
code $C/connections/$CIMD >/dev/null; has "CIMD strategy recorded" '"oauth_strategy":"cimd"'; has "CIMD ready" '"readiness":"ready"'

########## 3) Provider with OAuth but NO DCR / NO CIMD ##########
PRE=$(create "{\"name\":\"GW prereg\",\"endpoint_url\":\"$MOCK/mcp-prereg\",\"auth_type\":\"oauth\"}")
check "auto mode on no-DCR server → 422" 422 "$(code -X POST -H 'x-nk-client: web' $C/connections/$PRE/oauth/start)"
has  "actionable: requires pre-registered client" 'requires a pre-registered client'
has  "next action explains what to do" 'Use a pre-registered OAuth app'
code $C/connections/$PRE >/dev/null
hasnt "never silently downgraded" '"has_credential":true'
# owner supplies a pre-registered confidential client
check "invalid prereg (no secret for basic) 400" 400 "$(code -X POST "${H[@]}" -d "{\"name\":\"x\",\"endpoint_url\":\"$MOCK/mcp-prereg\",\"auth_type\":\"oauth\",\"oauth_mode\":\"preregistered\",\"oauth_client_id\":\"prereg-client\",\"oauth_token_auth_method\":\"client_secret_basic\"}" $C/connections)"
check "prereg mode without client id 400" 400 "$(code -X POST "${H[@]}" -d "{\"name\":\"x\",\"endpoint_url\":\"$MOCK/mcp-prereg\",\"auth_type\":\"oauth\",\"oauth_mode\":\"preregistered\"}" $C/connections)"
check "configure pre-registered client 200" 200 "$(code -X PATCH "${H[@]}" -d '{"oauth_mode":"preregistered","oauth_client_id":"prereg-client","oauth_client_secret":"prereg-secret-value","oauth_token_auth_method":"client_secret_basic"}' $C/connections/$PRE)"
hasnt "client secret never returned" 'prereg-secret-value'
has  "secret presence flag only" '"has_client_secret":true'
code -X POST -H 'x-nk-client: web' $C/connections/$PRE/oauth/start >/dev/null; AU=$(jget 'd.authorization_url')
has  "strategy preregistered" '"strategy":"preregistered"'
check "prereg client_id used" "prereg-client" "$(qp "$AU" client_id)"
hasnt "secret not in authorization URL" 'prereg-secret-value'
R=$(authorize "$AU"); check "prereg callback (client_secret_basic) 200" 200 "$(callback "$R")"
code -X POST -H 'x-nk-client: web' $C/connections/$PRE/test >/dev/null; has "prereg test ok" '"ok":true'
code -X PUT "${H[@]}" -d '{"permission":"allowed"}' $C/connections/$PRE/tools/get_weather/permission >/dev/null
check "invoke via prereg 200" 200 "$(code -X POST "${H[@]}" -d '{"arguments":{"city":"Semarang"}}' $C/connections/$PRE/tools/get_weather/invoke)"
has  "real result via prereg" 'Weather in Semarang'
code $C/connections/$PRE >/dev/null; has "prereg ready" '"readiness":"ready"'
# wrong secret → token exchange error, no credential stored
code -X PATCH "${H[@]}" -d '{"oauth_client_secret":"wrong-secret-zzz"}' $C/connections/$PRE >/dev/null
has  "changing client resets authorization" '"has_credential":false'
code -X POST -H 'x-nk-client: web' $C/connections/$PRE/oauth/start >/dev/null; R=$(authorize "$(jget 'd.authorization_url')")
check "token exchange error 400" 400 "$(callback "$R")"
has  "stage token_exchange named" 'token_exchange'
hasnt "wrong secret not echoed" 'wrong-secret-zzz'
code $C/connections/$PRE >/dev/null; has "no credential after failed exchange" '"has_credential":false'
# client_secret_post variant
code -X PATCH "${H[@]}" -d '{"oauth_client_secret":"prereg-secret-value","oauth_token_auth_method":"client_secret_post"}' $C/connections/$PRE >/dev/null
code -X POST -H 'x-nk-client: web' $C/connections/$PRE/oauth/start >/dev/null; R=$(authorize "$(jget 'd.authorization_url')")
check "prereg callback (client_secret_post) 200" 200 "$(callback "$R")"

########## 4) Negative / security ##########
X=$(create "{\"name\":\"GW nopkce\",\"endpoint_url\":\"$MOCK/mcp-bad-nopkce\",\"auth_type\":\"oauth\"}")
code -X POST -H 'x-nk-client: web' $C/connections/$X/oauth/start >/dev/null; has "AS without S256 refused" 'PKCE S256'
X=$(create "{\"name\":\"GW issuer\",\"endpoint_url\":\"$MOCK/mcp-bad-issuer\",\"auth_type\":\"oauth\"}")
code -X POST -H 'x-nk-client: web' $C/connections/$X/oauth/start >/dev/null; has "issuer mismatch refused" 'issuer'
X=$(create "{\"name\":\"GW ssrf\",\"endpoint_url\":\"$MOCK/mcp-bad-ssrf\",\"auth_type\":\"oauth\"}")
code -X POST -H 'x-nk-client: web' $C/connections/$X/oauth/start >/dev/null; has "metadata SSRF (token_endpoint → metadata IP) refused" 'token_endpoint rejected'
X=$(create "{\"name\":\"GW privAS\",\"endpoint_url\":\"$MOCK/mcp-bad-privateas\",\"auth_type\":\"oauth\"}")
code -X POST -H 'x-nk-client: web' $C/connections/$X/oauth/start >/dev/null; has "private-IP authorization server refused" 'Authorization server URL rejected'
X=$(create "{\"name\":\"GW nometa\",\"endpoint_url\":\"$MOCK/mcp-bad-nometa\",\"auth_type\":\"oauth\"}")
code -X POST -H 'x-nk-client: web' $C/connections/$X/oauth/start >/dev/null; has "PRM found but AS metadata missing" 'Protected resource found; OAuth authorization-server metadata missing'
X=$(create "{\"name\":\"GW wrongres\",\"endpoint_url\":\"$MOCK/mcp-wrongres\",\"auth_type\":\"oauth\"}")
code -X POST -H 'x-nk-client: web' $C/connections/$X/oauth/start >/dev/null; has "PRM for a different resource refused" 'different resource'
X=$(create "{\"name\":\"GW nooauth\",\"endpoint_url\":\"$MOCK/mcp-nooauth\",\"auth_type\":\"oauth\"}")
code -X POST -H 'x-nk-client: web' $C/connections/$X/oauth/start >/dev/null; has "server without OAuth: clear next action" 'may not use OAuth'
X=$(create "{\"name\":\"GW badtoken\",\"endpoint_url\":\"$MOCK/mcp-badtoken\",\"auth_type\":\"oauth\"}")
code -X POST -H 'x-nk-client: web' $C/connections/$X/oauth/start >/dev/null; R=$(authorize "$(jget 'd.authorization_url')")
check "token endpoint error → 400 page" 400 "$(callback "$R")"
code $C/connections/$X >/dev/null; has "stage-specific error stored" 'token_exchange'
hasnt "authorization code not logged in last_error" 'code_'
check "forged state 400" 400 "$(code "$BASE/api/connector/oauth/callback?code=x&state=forged-state-value")"
check "unauth start 401" 401 "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'x-nk-client: web' $C/connections/$DCR/oauth/start)"
check "start on non-oauth connection 400" 400 "$(code -X POST -H 'x-nk-client: web' $C/connections/$(create "{\"name\":\"plain\",\"endpoint_url\":\"$MOCK/mcp-open\",\"auth_type\":\"none\"}")/oauth/start)"
# state expiry: age the stored state in the local DB (allowed: local test DB only)
code -X POST -H 'x-nk-client: web' $C/connections/$CIMD/oauth/start >/dev/null; R=$(authorize "$(jget 'd.authorization_url')")
npx wrangler d1 execute nalukesa-production --local --command "UPDATE mcp_oauth_states SET created_at = created_at - 3600" >/dev/null 2>&1
check "expired state rejected 400" 400 "$(callback "$R")"
# disconnect / re-authorize keeps configuration
check "revoke credential 200" 200 "$(code -X POST -H 'x-nk-client: web' $C/connections/$CIMD/revoke-credential)"
has  "disconnected" '"has_credential":false'
has  "config kept after disconnect" '"name":"GW CIMD"'
check "invoke after disconnect blocked" 403 "$(code -X POST "${H[@]}" -d '{"arguments":{"city":"Solo"}}' $C/connections/$CIMD/tools/get_weather/invoke)"
code -X POST -H 'x-nk-client: web' $C/connections/$CIMD/oauth/start >/dev/null; R=$(authorize "$(jget 'd.authorization_url')")
check "re-authorize after disconnect 200" 200 "$(callback "$R")"
# global: no secrets anywhere in list / audit / invocations
code $C/connections >/dev/null; hasnt "list: no access tokens" 'oat_'; hasnt "list: no client secret" 'prereg-secret'
code $C/invocations >/dev/null; hasnt "invocations: no tokens" 'oat_'
for i in $DCR $CIMD $PRE; do code $C/connections/$i/audit >/dev/null; hasnt "audit $i: no tokens/codes/secrets" 'oat_\|ort_\|code_\|prereg-secret'; done

rm -f "$JAR" "$JAR2"
echo "---- $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
