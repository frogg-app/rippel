-- Real download progress for model installs.
--
-- ComfyUI-Manager reports its queue in *tasks*, so a 7 GB checkpoint is one
-- task that is either running or done — there is no percentage in anything it
-- says, and we refused to invent one. But the bytes are observable from a
-- different direction: Manager downloads in place (torchvision's `download_url`
-- writes straight to the destination path, no temp file), and ComfyUI core's
-- `GET /api/experiment/models/<folder>` stats every file in the folder and
-- returns its `size`. Polling that while the file grows is a genuine measure of
-- how much has arrived — verified against the live backend, where a 327 MB
-- LoRA was watched climbing 0 -> 32768 -> ... -> 327309314 in real time.
--
-- `bytes_total` is deliberately NOT the catalogue's size string. Manager states
-- sizes to three significant figures ("0.30GB" for a file that is actually
-- 327309314 bytes — 9% out), which is fine as prose and useless as the
-- denominator of a percentage. It is filled from a HEAD of the download URL
-- instead, which is exact, and left NULL when that cannot be obtained. A NULL
-- here is the signal that no percentage may be shown: the UI falls back to
-- bytes-so-far and elapsed time rather than guessing the rest.
--
-- Both are nullable because every part of this is best-effort. A transport that
-- cannot report bytes, a backend without the experiment endpoint, or a host
-- that refuses HEAD all leave these NULL and degrade to the previous display.

ALTER TABLE model_installs
  ADD COLUMN bytes_total    bigint CHECK (bytes_total    IS NULL OR bytes_total    >= 0),
  ADD COLUMN bytes_received bigint CHECK (bytes_received IS NULL OR bytes_received >= 0);
