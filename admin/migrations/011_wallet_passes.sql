-- A badge in a phone's wallet.
--
-- The pass is made by a service, which hands back a serial and a page that
-- offers the right button per device. Both are kept so that pressing "add to
-- my wallet" a second time -- on a new phone, or after clearing the wallet --
-- returns the same pass rather than minting another. One badge, one pass: two
-- passes for one number is two things to update and one of them will be missed.

alter table tickets add column wallet_serial  text;
alter table tickets add column wallet_url     text;
alter table tickets add column wallet_made_at timestamptz;

comment on column tickets.wallet_serial is
  'The pass serial at the wallet provider. Kept so the pass can be updated in '
  'place on every device that installed it.';

create unique index tickets_wallet_serial
  on tickets (wallet_serial)
  where wallet_serial is not null;
