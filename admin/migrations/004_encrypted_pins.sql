-- Whether a pinned file was encrypted before upload, and with what.
--
-- Recorded per pin rather than assumed globally, because the two states have
-- to coexist during the change: images pinned before encryption was turned on
-- are plaintext at their CIDs, and knowing which is which is what makes it
-- possible to re-pin them and unpin the originals.
alter table asset_pins
  add column encrypted boolean not null default false,
  add column algo      text;
