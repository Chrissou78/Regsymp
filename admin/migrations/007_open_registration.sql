-- Registration is open to anyone; a ticket is not.
--
-- An account is identity, a ticket is admission, and they are granted by
-- different people: anybody may create the first, only an admin issues the
-- second. That is what makes the guest list a whitelist rather than a race
-- for the first hundred sign-ups.
--
-- Which in turn makes verification necessary: with open registration anyone
-- can type somebody else's address, so an address has to prove itself before
-- a ticket is issued to it or a mailing is sent to it.
alter table attendees
  add column email_verified_at timestamptz,
  -- How a speaker's account joins up with their entry on the public page.
  -- Null for everyone else. Not a foreign key because the public list is a
  -- content document, not a table -- see store-pg.js.
  add column speaker_slug text,
  -- Who registered themselves, versus who an admin entered. Useful when
  -- deciding who to trust with a ticket.
  add column self_registered boolean not null default false;

create unique index attendees_speaker_slug on attendees (speaker_slug)
  where speaker_slug is not null;

-- Verification joins claiming and resetting as a reason to email a link.
alter table attendee_tokens
  drop constraint attendee_tokens_purpose_known;

alter table attendee_tokens
  add constraint attendee_tokens_purpose_known
  check (purpose in ('claim', 'reset', 'verify'));

-- Everyone who already has an account got it from an admin, and their
-- address came from the organisers rather than from a form, so it is as
-- verified as it is going to get.
update attendees set email_verified_at = created_at where password_hash is not null;
