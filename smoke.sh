#!/usr/bin/env bash
set -u
TMP=$(mktemp -d)
PORT=$((33000 + RANDOM % 3000))
BASE="http://127.0.0.1:$PORT"
DB_FILE="$TMP/db.json" PORT=$PORT node server.js >"$TMP/server.log" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
sleep 0.6

PASS=0; FAIL=0
check() { # desc expected actual
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "PASS: $1"; else FAIL=$((FAIL+1)); echo "FAIL: $1 expected=$2 actual=$3"; fi
}

req() { # method path json -> writes body to $TMP/body.json, prints http code
  local method=$1 path=$2 json=${3:-}
  if [ -n "$json" ]; then
    curl -s -o "$TMP/body.json" -w '%{http_code}' -X "$method" "$BASE$path" \
      -H 'Content-Type: application/json' -d "$json"
  else
    curl -s -o "$TMP/body.json" -w '%{http_code}' -X "$method" "$BASE$path"
  fi
}
code() { req "$@"; }
body() { req "$@" >/dev/null; cat "$TMP/body.json"; }

# 1) 建档
CLOCK=$(body POST /clocks '{"code":"T-001","escapementType":"杠杆式","balanceFrequency":"28800vph"}')
CID=$(echo "$CLOCK" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).data.id))')
check "建档" 201 "$(code POST /clocks '{"code":"T-002","escapementType":"x","balanceFrequency":"y"}')"

# 2) 登记复核（超差初测）
OPEN=$(body POST /clocks/$CID/reviews '{"inspector":"甲","concentricity":0.04,"staticBalance":2,"amplitude":260}')
RID=$(echo "$OPEN" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).data.id))')
ST=$(echo "$OPEN" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).data.state))')
check "超差初测->只准转校正" awaiting_correction "$ST"

# 3) 重复登记 409
check "重复登记409" 409 "$(code POST /clocks/$CID/reviews '{"inspector":"乙","concentricity":0.01,"staticBalance":1,"amplitude":260}')"
# 并发双提交：已有待复核，两个都应 409，且不落库
( code POST /clocks/$CID/reviews '{"inspector":"乙","concentricity":0.01,"staticBalance":1,"amplitude":260}' >"$TMP/c1" ) &
P1=$!
( code POST /clocks/$CID/reviews '{"inspector":"丙","concentricity":0.01,"staticBalance":1,"amplitude":260}' >"$TMP/c2" ) &
P2=$!
wait $P1 $P2
echo "并发结果: $(cat "$TMP/c1") / $(cat "$TMP/c2")"
check "并发重复提交均返回409" 409 "$( ( [ "$(cat "$TMP/c1")" = 409 ] && [ "$(cat "$TMP/c2")" = 409 ] ) && echo 409 )"

# 全新表上的并发登记：恰一个201，另一个409
NCID=$(body POST /clocks '{"code":"T-CONC","escapementType":"x","balanceFrequency":"y"}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).data.id))')
( code POST /clocks/$NCID/reviews '{"inspector":"乙","concentricity":0.01,"staticBalance":1,"amplitude":260}' >"$TMP/n1" ) &
P1=$!
( code POST /clocks/$NCID/reviews '{"inspector":"丙","concentricity":0.01,"staticBalance":1,"amplitude":260}' >"$TMP/n2" ) &
P2=$!
wait $P1 $P2
echo "新表并发结果: $(cat "$TMP/n1") / $(cat "$TMP/n2")"
SORTED=$(printf '%s\n%s\n' "$(cat "$TMP/n1")" "$(cat "$TMP/n2")" | sort | tr '\n' ',')
check "新表并发：一个201一个409" "201,409," "$SORTED"
NCOUNT=$(body GET /clocks/$NCID/reviews | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).data.length))')
check "并发只落库一条" 1 "$NCOUNT"

# 4) 超差时直接复测 -> 409
check "超差直接复测409" 409 "$(code POST /reviews/$RID/measurements '{"inspector":"甲","concentricity":0.01,"staticBalance":1,"amplitude":260}')"

# 5) 转校正（甲）
ST=$(body POST /reviews/$RID/corrections '{"operator":"甲","action":"重调游丝外桩同心"}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).data.state))')
check "转校正->待换人复测" awaiting_retest "$ST"

# 6) 校正人自己复测 409
check "校正人本人复测409" 409 "$(code POST /reviews/$RID/measurements '{"inspector":"甲","concentricity":0.01,"staticBalance":1,"amplitude":260}')"

# 7) 乙复测达标（第一次）
R1=$(body POST /reviews/$RID/measurements '{"inspector":"乙","concentricity":0.01,"staticBalance":1,"amplitude":265}')
ST=$(echo "$R1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).data.state))')
check "换人首次达标->复测中" retesting "$ST"
check "首次达标未恢复" x "$(echo "$R1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).decision.restored?"BAD":"x"))')"

# 8) 间隔不足4小时，第二次达标 -> 不恢复
ST=$(body POST /reviews/$RID/measurements '{"inspector":"丙","concentricity":0.02,"staticBalance":2,"amplitude":270}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).decision.code))')
check "间隔不足4h不恢复" INTERVAL_TOO_SHORT "$ST"

# 9) 中间出现不合格 -> 连续两次被打断，只准转校正
ST=$(body POST /reviews/$RID/measurements '{"inspector":"丙","concentricity":0.05,"staticBalance":2,"amplitude":270}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).data.state))')
check "复测超差->只准转校正" awaiting_correction "$ST"

# 10) 甲再次校正，乙复测，两次达标间隔≥4h -> 恢复排队
body POST /reviews/$RID/corrections '{"operator":"甲","action":"再校正摆轮静平衡"}' >/dev/null
read T0 T1 <<EOF
$(node -e 'const t=Date.now()+60000;console.log(new Date(t).toISOString(),new Date(t+5*3600000).toISOString())')
EOF
body POST /reviews/$RID/measurements "{\"inspector\":\"乙\",\"concentricity\":0.01,\"staticBalance\":1,\"amplitude\":270,\"at\":\"$T0\"}" >/dev/null
FINAL=$(body POST /reviews/$RID/measurements "{\"inspector\":\"丙\",\"concentricity\":0.02,\"staticBalance\":4.9,\"amplitude\":272,\"at\":\"$T1\"}")
ST=$(echo "$FINAL" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.data.state)})')
check "两连达标间隔4h换人->恢复排队" restored "$ST"
RESTORED=$(echo "$FINAL" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).decision.restored))')
check "decision.restored=true" true "$RESTORED"

# 11) 恢复后再测 409；重新登记允许
check "恢复后补测409" 409 "$(code POST /reviews/$RID/measurements '{"inspector":"乙","concentricity":0.01,"staticBalance":1,"amplitude":270}')"
check "恢复后可重新登记" 201 "$(code POST /clocks/$CID/reviews '{"inspector":"丁","concentricity":0.01,"staticBalance":1,"amplitude":270}')"

# 12) 更换摆轮：旧复核失效且可查，列表/历史/最新状态一致
RID2=$(body GET /clocks/$CID/reviews | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).data[0].id))')
check "换件前为进行中" open "$(body GET /clocks/$CID/reviews | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).data[0].status))')"
REP=$(body POST /clocks/$CID/part-replacements '{"operator":"丁","parts":["balance"],"note":"换新摆轮"}')
GEN=$(echo "$REP" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).clock.componentGeneration))')
check "部件代次+1" 1 "$GEN"
check "旧复核失效" invalidated "$(body GET /clocks/$CID/reviews | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).data.find(r=>r.id===process.argv[1]).state))' "$RID2")"
# 三个视图状态一致
L=$(body GET /clocks | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).data.find(c=>c.id===process.argv[1]).reviewStatus))' "$CID")
H=$(body GET /clocks/$CID/history | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).data.latestReviewState.state))')
S=$(body GET /clocks/$CID/review-status | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).data.state))')
check "列表状态=invalidated" invalidated "$L"
check "历史状态=invalidated" invalidated "$H"
check "最新状态=invalidated" invalidated "$S"
# 失效后无进行中复核，重新登记（新代次）
check "失效后无进行中复核" false "$(body GET /clocks/$CID/review-status | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).data.status==="open"))')"
REOPEN_CODE=$(req POST /clocks/$CID/reviews '{"inspector":"戊","concentricity":0.01,"staticBalance":1,"amplitude":270}')
R3=$(cat "$TMP/body.json")
check "失效后重新登记201" 201 "$REOPEN_CODE"
G3=$(echo "$R3" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).data.componentGeneration))')
check "新复核代次=1" 1 "$G3"
# 旧记录仍可查，数量为3（restored, invalidated, open）
N=$(body GET /clocks/$CID/reviews | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).data.length))')
check "旧记录可查共3条" 3 "$N"

# 13) 边界：0.03 与 5 恰好合格
R4=$(body POST /clocks/$(body POST /clocks '{"code":"T-009","escapementType":"x","balanceFrequency":"y"}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).data.id))')/reviews '{"inspector":"甲","concentricity":0.03,"staticBalance":5,"amplitude":260}')
check "0.03/5.0临界值达标" retesting "$(echo "$R4" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).data.state))')"

kill $SRV 2>/dev/null
echo "---- PASS=$PASS FAIL=$FAIL ----"
echo "tmp=$TMP"
exit $FAIL
