-- People attending the event, and their tickets.
--
-- Deliberately separate from admin_users. Different population, different
-- fields, different sign-in surface: an attendee must never be one accidental
-- join away from the content editor's privileges.
create table attendees (
  id            bigserial   primary key,
  email         text        not null unique,
  -- Null until they claim the account. Presence of a hash is what
  -- distinguishes "invited" from "signed up".
  password_hash text,

  -- What they are. VIP is not here: it is a property of the ticket, because
  -- it is defined by which side events the ticket opens, not by the person.
  role          text        not null default 'visitor',

  first_name    text,
  last_name     text,
  birth_date    date,
  country       text,
  company       text,
  position      text,
  -- {"linkedin": "...", "x": "..."} — open-ended, because the list of
  -- networks worth recording changes faster than a schema should.
  socials       jsonb       not null default '{}'::jsonb,

  -- Speakers only. The photo is a path into content_documents rather than
  -- bytes, so it goes through the same storage and IPFS pinning as every
  -- other image on the site.
  description   text,
  photo_path    text,

  -- Consent is a column, not an afterthought: bulk mail to a stored list
  -- needs a lawful basis and a record of when it was given.
  consent_marketing boolean not null default false,
  consent_at        timestamptz,

  created_at    timestamptz not null default now(),
  created_by    text,
  claimed_at    timestamptz,
  last_login_at timestamptz,
  notes         text,

  constraint attendees_role_known check (role in ('visitor', 'speaker'))
);

create index attendees_role on attendees (role);

-- Tickets, numbered in one sequence across the event.
--
-- 1-33 are VIP and 34-100 general, so no number is ever used twice and the
-- numbering itself carries the tier. Capacity is enforced by the range rather
-- than by counting rows and hoping two requests do not race.
create table tickets (
  id            bigserial   primary key,
  attendee_id   bigint      not null references attendees (id) on delete cascade,
  number        integer     not null unique,
  tier          text        not null,
  -- The QR payload. Long and random: a guessable ticket is a free ticket.
  code          text        not null unique,
  issued_at     timestamptz not null default now(),
  issued_by     text,
  revoked_at    timestamptz,
  checked_in_at timestamptz,

  constraint tickets_tier_known check (tier in ('vip', 'general')),
  -- The rule, in the one place it cannot be forgotten.
  constraint tickets_number_matches_tier check (
    (tier = 'vip'     and number between 1  and 33) or
    (tier = 'general' and number between 34 and 100)
  )
);

create index tickets_attendee on tickets (attendee_id);

-- What a ticket opens. VIP means "gets into these side events", so access is
-- a set per ticket rather than a level, and adding a session later is a row
-- rather than a migration.
create table ticket_access (
  ticket_id bigint not null references tickets (id) on delete cascade,
  area      text   not null,
  primary key (ticket_id, area)
);
