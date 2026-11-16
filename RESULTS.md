# RESULTS — free-model-aggregator-02 v2 (Fase 1b, lane burner)

Build: OpenCode via `oc-vm.sh`, lane **DeepSeek burner (100milionseek),
provider `burner`, model `deepseek-v4.1-flash-free`** — workload publik.
Sesi build (±15:20–16:34 WIB) TERBUNUH SIGTERM eksternal sebelum menulis
dokumen ini; tabel di bawah ditulis operator dari bukti grade sesi
(`work/final/summary.json`, `work/det*`, `work/replay*`, log sesi) — angka
disalin, bukan ditebak. Baseline v1 (Fase 1, Xingchi): skor 61/61/61.

## Grade-local — 3 practice trial (scorer asli kit, driver process)

| Trial | Skor | Quality | Served | Wire | Failover | Catalog | Calls | Working |
|---|---|---|---|---|---|---|---|---|
| trial-0 | 94 | 90 | 100 | 100 | 100 | 100 | 6 | 1 |
| trial-1 | 94 | 90 | 100 | 100 | 100 | 100 | 6 | 1 |
| trial-2 | 94 | 90 | 100 | 100 | 100 | 100 | 6 | 1 |

Counts: trials 3, finished 3, timeout 0, nondeterministic 0, voids_rerun 0.
Perintah: `node kit/cli/makefun.mjs grade-local --kit kit --bot . --driver
process --dotenv .env --instances 3 --worktree` (dari repo/, kit/.env salinan
sementara sesi ini). Target 94 + calls 6 di ketiganya: TERCAPAI — sama dengan
plafon field (228 entry di skor 94; skor maksimum field 94, quality 90).

## Determinisme — LOLOS
- Rerun trial-0 (replay cassette): `scores.json` + `state.json`
  byte-identical.
- Scorer ganda pada export sama: `SCORES-BYTE-IDENTICAL` (sha256 `4415e189…`).
- Replay ulang kedua: `STATE-BYTE-IDENTICAL` (replay1 vs replay2).
- Bukti: `work/det/`, `work/det-a/`, `work/det-c/`, `work/det-replay/`.

## `--list` — LOLOS
`node main.ts --list` byte-identical dengan katalog Fase 1
(`LIST-BYTE-IDENTICAL-TO-PHASE1`): 1 provider (`openrouter`), 14 model `:free`.

## Verifikasi wire SSE
- OpenAI stream (p02): terverifikasi di capture mandiri — frames 3,
  **finishChunks 1, done 1**, token `COMET-3884` utuh.
- Anthropic stream (p03): terverifikasi oleh scorer kit — wire 100 +
  served 100 di ketiga trial berarti keenam prompt lolos valid, termasuk
  p03 yang di v1 gagal ("answer did not carry the token"). Capture mandiri
  Anthropic sesi ini belum sempat jalan (sesi terbunuh saat memperbaiki
  script capture-nya) — verifikasi scorer di atas yang berlaku.
- Perintah harness tunggal: `repo/run_trial.sh <trial> <label>`.

## Perubahan kode
- `main.ts` 13.167 → 18.268 byte: normalisasi buffer-and-emit
  (`normalizeStream` / `normalizeJson` → `StreamAnswer`; emitter ulang
  `openaiEvents` / `anthroEvents`). Routing TETAP (inkling-2-small 403 →
  failover super-vl). Detail: `BUILD_NOTES.md`.

## Biaya sesi
- Burner = $0. Tidak ada angka token/cost sesi di log (sesi terbunuh sebelum
  ringkasan OpenCode tercetak). Tidak ada biaya OpenRouter dari sesi ini.
  Sisa kredit OpenRouter saat misi: $0,85 (Claude tertutup, lantai $3).
