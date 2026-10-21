-- One-time codes that pair a machine with a deployment.
--
-- This replaces the per-deployment binary. A machine used to be enrolled by
-- downloading an executable whose *filename* carried the server address and the
-- deployment token; that meant every rippel had to serve its own build, produced
-- names no one could read, and broke whenever a browser renamed the download.
-- A person reading eight characters aloud cannot be broken by a browser.
--
-- The code is a credential — it is redeemed without a session, because the
-- machine being set up has no rippel login — so it is stored the way a password
-- is: only a SHA-256 of the normalised code is kept, and the plaintext exists
-- only in the response that issued it. A dump of this table cannot pair anything.
--
-- One row per deployment, enforced by the primary key rather than by a rule in
-- the route: issuing a new code overwrites the old one, which is exactly the
-- "issuing a new one invalidates any outstanding code" requirement, and it
-- cannot be got wrong by a caller that forgets to delete first.
--
-- `redeemed_at` is what makes a code single-use, and it is set by the same
-- UPDATE that reads the row (see `pairing.ts`), so two agents racing one code
-- resolve in Postgres rather than in application logic. The row is kept after
-- redemption rather than deleted, so a second attempt can be told "that code has
-- already been used" instead of the less helpful "no such code".

CREATE TABLE deployment_pairing_codes (
  deployment_id uuid PRIMARY KEY REFERENCES deployments(id) ON DELETE CASCADE,
  -- SHA-256 of the normalised (uppercased, separators removed) code, hex.
  -- Never the code itself.
  code_hash     text NOT NULL,
  expires_at    timestamptz NOT NULL,
  redeemed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL
);

-- Redemption arrives with a code and nothing else, so the hash is the only way
-- in. Unique because two live deployments sharing a code hash would make
-- redemption ambiguous, and the generator must never be allowed to collide
-- quietly.
CREATE UNIQUE INDEX deployment_pairing_codes_hash_key
  ON deployment_pairing_codes (code_hash);
