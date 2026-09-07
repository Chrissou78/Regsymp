-- IPFS pins, keyed by content digest rather than by path.
--
-- The same bytes always produce the same CID, so keying on the digest means an
-- image reused at two paths is pinned once, and re-saving an unchanged image
-- costs nothing. It also joins straight onto content_documents.digest.
create table asset_pins (
  digest    text        primary key,
  cid       text        not null,
  bytes     integer     not null,
  filename  text,
  provider  text        not null default 'pinata',
  pinned_at timestamptz not null default now()
);

create index asset_pins_cid on asset_pins (cid);

-- Why something is not pinned.
--
-- Pinning is best-effort by design: the image is already durable in Postgres,
-- so a Pinata outage must not fail a save. But "not pinned" then has two very
-- different causes -- not tried yet, or tried and failed -- and nobody
-- administering this can read the server log to tell them apart.
create table asset_pin_failures (
  digest       text        primary key,
  path         text,
  error        text        not null,
  attempts     integer     not null default 1,
  last_attempt timestamptz not null default now()
);
