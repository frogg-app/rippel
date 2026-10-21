-- Who may see an asset.
--
--   private  the owner only. The default, and what every existing row becomes,
--            so nothing generated before this migration is suddenly exposed.
--   link     anyone holding the share URL. The token is the only key; the
--            asset id alone still opens nothing.
--   public   anyone, by the same share URL — and eligible for any future
--            public listing. Nothing lists public assets yet.
--
-- The token is minted the first time an asset leaves `private` and kept after
-- that, so flipping back to private and out again does not break a link the
-- owner already sent. Making it private is what revokes it: the share route
-- refuses a private asset whatever token it is asked with.
ALTER TABLE assets
  ADD COLUMN visibility  text NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private', 'link', 'public')),
  ADD COLUMN share_token text UNIQUE;
