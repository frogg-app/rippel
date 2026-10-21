-- Sharing an asset with named users, and the archive that replaces the trash.
--
-- A share row grants one user read access to one asset: it appears under their
-- "Shared with me", and its bytes and job settings become readable to them.
-- It does not let them change, star, collect or re-share it. Independent of
-- `visibility` (019): a private asset can still be shared with a colleague,
-- and making an asset public does not create rows here.
--
-- Rows go with either end: deleting the asset or the user removes the grant.
CREATE TABLE asset_shares (
  asset_id   uuid NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (asset_id, user_id)
);

-- "Shared with me" walks this by recipient.
CREATE INDEX asset_shares_user_idx ON asset_shares (user_id, asset_id);

-- The archive is `deleted_at IS NOT NULL`, unchanged; what is new is that it
-- is now emptied. The purge sweeps by age, so it gets its own index.
CREATE INDEX assets_archived_idx ON assets (deleted_at) WHERE deleted_at IS NOT NULL;
