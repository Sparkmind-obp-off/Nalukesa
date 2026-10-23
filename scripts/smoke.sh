#!/usr/bin/env bash
# API smoke/integration test against a running instance.
# Usage: BASE=http://localhost:3000 PW=... bash scripts/smoke.sh
# WARNING: writes test records. Run only against a local/disposable database.
set -u
BASE=${BASE:-http://localhost:3000}
PW=${PW:?set PW}
JAR=$(mktemp)
PASS=0; FAIL=0
H=(-H 'Content-Type: application/json' -H 'x-nk-client: web')
check() { # name expected actual
  if [ "$2" == "$3" ]; then PASS=$((PASS+1)); echo "PASS  $1"; else FAIL=$((FAIL+1)); echo "FAIL  $1 (expected $2, got $3)"; fi
}
code() { curl -s -o /tmp/nk_body -w '%{http_code}' -b "$JAR" -c "$JAR" "$@"; }

check "health 200" 200 "$(code "$BASE/api/health")"
check "unauthenticated list 401" 401 "$(code "$BASE/api/niches")"
check "unauthenticated write 401" 401 "$(code -X POST "${H[@]}" -d '{}' "$BASE/api/niches")"
check "wrong password 401" 401 "$(code -X POST "${H[@]}" -d '{"password":"nope"}' "$BASE/api/auth/login")"
check "login 200" 200 "$(code -X POST "${H[@]}" -d "{\"password\":\"$PW\"}" "$BASE/api/auth/login")"
check "authenticated list 200" 200 "$(code "$BASE/api/niches")"
check "write without client header 403" 403 "$(code -X POST -H 'Content-Type: application/json' -d '{}' "$BASE/api/niches")"
check "invalid niche 400" 400 "$(code -X POST "${H[@]}" -d '{"name":""}' "$BASE/api/niches")"
check "unknown field 400" 400 "$(code -X POST "${H[@]}" -d '{"name":"x","status":"Hypothesis","confidence":"Low","id":99}' "$BASE/api/niches")"
check "create niche 201" 201 "$(code -X POST "${H[@]}" -d '{"name":"SMOKE niche","status":"Hypothesis","confidence":"Unrated","audience":"<script>alert(1)</script>"}' "$BASE/api/niches")"
NID=$(sed -E 's/.*"id":([0-9]+).*/\1/' /tmp/nk_body)
check "xss stored as plain text" 1 "$(grep -c '<script>alert(1)</script>' /tmp/nk_body)"
check "unsafe url rejected 400" 400 "$(code -X POST "${H[@]}" -d "{\"name\":\"P\",\"niche_id\":$NID,\"platform\":\"Shopee\",\"listing_url\":\"javascript:alert(1)\",\"status\":\"Researching\"}" "$BASE/api/products")"
check "missing FK rejected 400" 400 "$(code -X POST "${H[@]}" -d '{"name":"P","niche_id":999999,"platform":"Shopee","listing_url":"https://shopee.co.id/x","status":"Researching"}' "$BASE/api/products")"
check "create product 201" 201 "$(code -X POST "${H[@]}" -d "{\"name\":\"SMOKE product\",\"niche_id\":$NID,\"platform\":\"Shopee\",\"listing_url\":\"https://shopee.co.id/x\",\"status\":\"Researching\"}" "$BASE/api/products")"
PID=$(sed -E 's/.*"id":([0-9]+).*/\1/' /tmp/nk_body)
check "offer snapshot 201" 201 "$(code -X POST "${H[@]}" -d "{\"product_id\":$PID,\"checked_at\":\"2026-10-20\",\"price_idr\":\"Rp 149.000\",\"advertised_commission_pct\":\"\"}" "$BASE/api/offer_snapshots")"
check "unknown commission stays null" 1 "$(grep -c '"advertised_commission_pct":null' /tmp/nk_body)"
OID=$(sed -E 's/.*"id":([0-9]+).*/\1/' /tmp/nk_body)
check "append-only patch 409" 409 "$(code -X PATCH "${H[@]}" -d '{"price_idr":"1"}' "$BASE/api/offer_snapshots/$OID")"
check "append-only delete 409" 409 "$(code -X DELETE -H 'x-nk-client: web' "$BASE/api/offer_snapshots/$OID")"
check "delete niche with dependents 409" 409 "$(code -X DELETE -H 'x-nk-client: web' "$BASE/api/niches/$NID")"
check "patch niche 200" 200 "$(code -X PATCH "${H[@]}" -d '{"status":"Researching"}' "$BASE/api/niches/$NID")"
check "decision on missing record 400" 400 "$(code -X POST "${H[@]}" -d '{"entity_type":"niches","entity_id":999999,"decision":"Hold","rationale":"x","decided_at":"2026-10-23"}' "$BASE/api/decisions")"
check "decision 201" 201 "$(code -X POST "${H[@]}" -d "{\"entity_type\":\"niches\",\"entity_id\":$NID,\"decision\":\"Hold\",\"rationale\":\"Smoke test\",\"decided_at\":\"2026-10-23\"}" "$BASE/api/decisions")"
check "search 200" 200 "$(code "$BASE/api/niches?q=SMOKE&status=Researching")"
check "search finds record" 1 "$(grep -c 'SMOKE niche' /tmp/nk_body)"
check "overview 200" 200 "$(code "$BASE/api/overview")"
check "export csv 200" 200 "$(code "$BASE/api/export/niches.csv")"
check "csv validate (1 bad row) 200" 200 "$(code -X POST -H 'x-nk-client: web' -H 'Content-Type: text/csv' --data-binary $'name,status,confidence\nCSV ok,Hypothesis,Low\n,Hypothesis,Low\n' "$BASE/api/import/niches/validate")"
check "csv reports 1 invalid" 1 "$(grep -c '"invalid":1' /tmp/nk_body)"
check "csv commit with errors 400" 400 "$(code -X POST -H 'x-nk-client: web' -H 'Content-Type: text/csv' --data-binary $'name,status,confidence\nCSV ok,Hypothesis,Low\n,Hypothesis,Low\n' "$BASE/api/import/niches/commit")"
check "csv commit valid 200" 200 "$(code -X POST -H 'x-nk-client: web' -H 'Content-Type: text/csv' --data-binary $'name,status,confidence\nSMOKE csv,Hypothesis,Low\n' "$BASE/api/import/niches/commit")"
BIG=$(head -c 70000 /dev/zero | tr '\0' 'a')
check "oversized body 413" 413 "$(code -X POST "${H[@]}" -d "{\"name\":\"$BIG\"}" "$BASE/api/niches")"
check "unknown entity 404" 404 "$(code "$BASE/api/users")"
check "logout 200" 200 "$(code -X POST -H 'x-nk-client: web' "$BASE/api/auth/logout")"
check "after logout 401" 401 "$(code "$BASE/api/niches")"
rm -f "$JAR"
echo "---- $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
