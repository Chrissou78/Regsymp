-- Service credentials, so the host dashboard needs one variable instead of
-- five and they can be rotated from the admin rather than by whoever happens
-- to have console access.
--
-- DATABASE_URL is deliberately not among them: reading this table requires a
-- connection, so the credential that opens the connection cannot live in it.
create table app_secrets (
  name       text        primary key,
  value      text        not null,
  updated_at timestamptz not null default now(),
  updated_by text
);
