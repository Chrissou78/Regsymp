-- One-time links: claiming an account, and resetting a forgotten password.
--
-- Only the SHA-256 of the token is stored, so a copy of this table does not
-- let anyone redeem an outstanding link — the same reason the old admin
-- invitations were stored hashed.
create table attendee_tokens (
  token_hash  text        primary key,
  attendee_id bigint      not null references attendees (id) on delete cascade,
  purpose     text        not null,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now(),

  constraint attendee_tokens_purpose_known check (purpose in ('claim', 'reset'))
);

create index attendee_tokens_attendee on attendee_tokens (attendee_id, purpose);
