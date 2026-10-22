-- What a downloadable file holds, read off its safetensors header before
-- anyone installs it. Keyed by URL because a catalogue entry has no row of its
-- own; the answer is a property of the bytes behind the URL and never changes.
CREATE TABLE IF NOT EXISTS weights_layouts (
  url        text PRIMARY KEY,
  layout     text NOT NULL CHECK (layout IN ('bundled', 'diffusion-only', 'diffusers', 'unknown')),
  checked_at timestamptz NOT NULL DEFAULT now()
);
