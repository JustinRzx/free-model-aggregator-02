#!/usr/bin/env bash
set -euo pipefail
ROOT="$(realpath "$(dirname "$0")")"
if [[ -d "$ROOT/../kit" && -f "$ROOT/../.env" ]]; then
  KIT="$(realpath "$ROOT/../kit")"
  DOTENV="$(realpath "$ROOT/../.env")"
else
  KIT="$(realpath "$ROOT/kit")"
  DOTENV="$(realpath "$ROOT/.env")"
fi
TRIAL="${1:-0}"
LABEL="${2:-final}"
[[ "$TRIAL" =~ ^[012]$ && "$LABEL" =~ ^[a-zA-Z0-9_-]+$ ]] || exit 2
[[ -f "$DOTENV" ]] || { printf 'No dotenv at %s\n' "$DOTENV" >&2; exit 2; }
OUT="$ROOT/runs/$LABEL/trial-$TRIAL"
[[ ! -e "$OUT" ]] || { printf 'Evidence exists: %s\n' "$OUT" >&2; exit 2; }
mkdir -p "$OUT/state" "$OUT/record" "$OUT/config" "$OUT/tmp"
chmod 700 "$OUT/config" "$OUT/tmp"
ENV_PID=''
GW_PID=''
cleanup() {
  [[ -z "$ENV_PID" ]] || { kill -TERM "$ENV_PID" 2>/dev/null || true; wait "$ENV_PID" 2>/dev/null || true; }
  [[ -z "$GW_PID" ]] || { kill -TERM "$GW_PID" 2>/dev/null || true; wait "$GW_PID" 2>/dev/null || true; }
}
trap cleanup EXIT

INSTANCE="$(sha256sum "$KIT/practice/trial-$TRIAL/input/prompt.txt" | cut -d' ' -f1)"
GW_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')"

node - "$OUT/config/gateway.json" "$DOTENV" "$TRIAL" "$INSTANCE" "$GW_TOKEN" <<'NODE'
const fs = require('node:fs');
const [file, dotenv, index, instance, token] = process.argv.slice(2);
const env = {};
for (const line of fs.readFileSync(dotenv, 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const key = env.OPENROUTER_API_KEY;
if (!key) { process.stderr.write('dotenv has no OPENROUTER_API_KEY\n'); process.exit(1); }
const config = {
  format: 'agent-fun/gateway-config/v1',
  mode: 'live',
  trial: { index: Number(index), instance_sha256: instance },
  policy: {
    models: ['openrouter/*:free'],
    budget_micro_usd: '10000',
    max_requests_per_trial: 60,
    max_output_tokens_per_request: 8192,
    max_request_bytes: 8388608,
    void_upstream_error_share: '1.000000000',
  },
  upstream: { adapter: 'provider' },
  keys: { openrouter: key },
  mask: [key],
  client: { lane: 'entry', token },
};
fs.writeFileSync(file, `${JSON.stringify(config)}\n`, { mode: 0o600 });
NODE

MAKEFUN_CONFIG_DIR="$OUT/config" MAKEFUN_RECORD_DIR="$OUT/record" MAKEFUN_GATEWAY_PORT=0 MAKEFUN_GATEWAY_HOST=127.0.0.1 \
  node "$KIT/gateway/gateway.mjs" >"$OUT/gateway.stdout" 2>"$OUT/gateway.stderr" &
GW_PID=$!
for ((i=0; i<200; i++)); do
  [[ -f "$OUT/record/ready" ]] && break
  kill -0 "$GW_PID" 2>/dev/null || { printf 'Gateway exited early\n' >&2; cat "$OUT/gateway.stderr" >&2; exit 1; }
  sleep 0.05
done
GW_PORT="$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).port)' "$OUT/record/ready")"

MAKEFUN_ENV_DATA_DIR="$KIT/practice/trial-$TRIAL/input/env" MAKEFUN_STATE_DIR="$OUT/state" MAKEFUN_ENV_PORT=0 \
  node "$KIT/program/env/server.mjs" >"$OUT/env.stdout" 2>"$OUT/env.stderr" &
ENV_PID=$!
for ((i=0; i<200; i++)); do
  [[ -f "$OUT/state/ready" ]] && break
  kill -0 "$ENV_PID" 2>/dev/null || { printf 'Env exited early\n' >&2; cat "$OUT/env.stderr" >&2; exit 1; }
  sleep 0.05
done
ENV_PORT="$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).port)' "$OUT/state/ready")"

MAKEFUN_PROMPT_FILE="$KIT/practice/trial-$TRIAL/input/prompt.txt" \
MAKEFUN_ENV_URL="http://127.0.0.1:$ENV_PORT" \
OPENAI_BASE_URL="http://127.0.0.1:$GW_PORT/v1" \
OPENAI_API_KEY="$GW_TOKEN" \
ANTHROPIC_BASE_URL="http://127.0.0.1:$GW_PORT" \
ANTHROPIC_API_KEY="$GW_TOKEN" \
timeout 170 node "$ROOT/main.ts" >"$OUT/bot.stdout" 2>"$OUT/bot.stderr"

kill -TERM "$ENV_PID" 2>/dev/null || true
wait "$ENV_PID" 2>/dev/null || true
ENV_PID=''
kill -TERM "$GW_PID" 2>/dev/null || true
wait "$GW_PID" 2>/dev/null || true
GW_PID=''

mkdir -p "$OUT/bodies"
cp "$OUT/record/cassette.json" "$OUT/cassette.json"
find "$OUT/record/blobs" -mindepth 2 -maxdepth 2 -type f -exec cp {} "$OUT/bodies/" \;
MAKEFUN_OUTPUT_DIR="$OUT/state/export" MAKEFUN_REFERENCE_DIR="$KIT/practice/trial-$TRIAL/reference" \
MAKEFUN_SCORES_DIR="$OUT" MAKEFUN_CASSETTE_DIR="$OUT" \
  node "$KIT/program/scorer/score.mjs" | tee "$OUT/score.log"

MAKEFUN_PROMPT_FILE="$KIT/practice/trial-$TRIAL/input/prompt.txt" node "$ROOT/main.ts" --list >"$OUT/list.json" 2>/dev/null
node -e 'const fs=require("node:fs"); const path=process.argv[1]; const state=JSON.parse(fs.readFileSync(path+"/state/export/state.json","utf8")); const bytes=fs.readFileSync(path+"/list.json","utf8"); if(JSON.stringify(state.catalog)+"\n"!==bytes) throw Error("Registered catalog differs"); console.log("Catalog verified: "+Buffer.byteLength(bytes)+" bytes, "+state.catalog.providers.length+" providers");' "$OUT" | tee "$OUT/catalog-check.log"
