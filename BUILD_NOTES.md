# BUILD_NOTES — free-model-aggregator-02 v2 (Fase 1b)

## Masalah (diagnosis Fase 1, bukti `work/diagnose/`)
Server v1 meneruskan (passthrough) stream upstream apa adanya. Dua bug:
1. p02 OpenAI: provider mengirim DUA chunk `finish_reason:"stop"` (finish
   biasa + chunk usage yang juga membawa finish_reason) → check
   `stream_order` gagal ("two finish chunks").
2. p03 Anthropic: token terpecah 3 chunk content ("F" + "ALCON-6" + "712")
   di tengah deretan reasoning-delta → translator Anthropic v1
   menghilangkan content → check `content` gagal (token tidak terbawa).
3. inkling-2-small 403 HARD permanen → plafon riil skor 94 / quality 90.

## Desain perbaikan — buffer-and-emit
Semua jawaban (stream maupun JSON) dinormalisasi dulu ke satu bentuk
tengah, lalu di-emit ulang per wire. Tidak ada lagi passthrough mentah.
- `normalizeStream(raw)`: iterasi semua frame SSE; kumpulkan
  `delta.content` (abaikan `reasoning` / `reasoning_details` /
  `reasoning_content` — tidak pernah dibaca); akumulasi tool-call delta
  per index (`collectTools`, arguments dirangkai); ambil finish_reason
  PERTAMA; ambil usage (bila ada). Hasil: `StreamAnswer { content,
  finish, usage, calls }`.
- `normalizeJson(answer)`: bentuk tengah yang sama dari jawaban JSON
  (content string / parts teks, tool_calls, finish_reason, usage).
- `openaiEvents(ans, model)`: chunk content (bila ada) → chunk tool_calls
  (bila ada) → TEPAT SATU chunk finish (`ans.finish ?? "stop"`, usage
  dilampirkan) → `[DONE]`.
- `anthroEvents(ans, model)`: message_start → content_block_start →
  SATU content_block_delta berisi teks utuh → content_block_stop →
  (blok tool_use bila ada) → message_delta (stop_reason dari finish +
  usage output_tokens) → message_stop. TEPAT SATU stop.
- `anthropicAnswer(ans, model)`: jawaban JSON Anthropic dari bentuk tengah
  yang sama (dipakai jalur non-stream).
- `stopReasonOf`: length → max_tokens; tool_calls/function_call →
  tool_use; content_filter → refusal; lainnya → end_turn.

## Keputusan
- Normalisasi penuh (bukan tambal potong): passthrough tidak bisa
  menjamin "tepat satu finish" karena chunk usage kedua datang dari
  provider; buffer-and-emit adalah satu-satunya cara yang deterministik.
- Usage dilampirkan ke chunk finish OpenAI (bukan chunk terpisah tanpa
  choices) — sesuai spesifikasi HANDOFF Fase 1b.
- Anthropic stream selalu SATU blok teks + SATU delta utuh (bukan
  delta per chunk upstream) — menghilangkan risiko token terpecah dan
  reasoning-delta bocor.
- Routing TIDAK diubah: rating tertinggi per kapabilitas, inkling 403 →
  failover super-vl, provider mati setelah 2 kegagalan, jejak refusal di
  header `x-makefun-upstream-failures`. JANGAN hardcode token/model.

## Yang dicoba-ditolak
- Tambalan minimal pada loop passthrough (buang chunk finish kedua saja):
  ditolak — tidak menyelesaikan p03 (reasoning-delta + token terpecah
  tetap lolos) dan rapuh terhadap variasi chunk provider.
- Emit ulang tiap delta upstream apa adanya: ditolak — mempertahankan
  urutan chunk provider (dua finish, reasoning-delta).
- Menghapus chunk usage: ditolak — usage dibutuhkan wire check
  (output_tokens ≥1) dan dilampirkan ke finish chunk.

## Validasi
- grade-local 3 trial: 94/94/94, calls 6, served/wire/failover/catalog
  100, quality 90, working 1. Determinisme + `--list` byte-identical
  (lihat RESULTS.md). Maks 2 ronde tuning: TIDAK TERPAKAI (ronde pertama
  langsung 94/94/94).
- Sesi build terbunuh SIGTERM eksternal di akhir (saat verifikasi capture
  mandiri Anthropic); dokumen ini + RESULTS.md ditulis operator dari bukti
  grade. Tidak ada perubahan kode sesudah grade final.
