-- A person on the guest list before anybody has their email address.
--
-- Twenty-six speakers are published on the site and most of them have never
-- given one. They are still people who will be at the event, who need a badge
-- and a number, and who belong on the guest list rather than in a separate
-- list of names kept somewhere else until the addresses turn up.
--
-- So email becomes optional. What it costs: such a person cannot sign in --
-- there is nothing to sign in as -- and cannot be emailed a link. What it
-- buys: they exist, they can be given a badge, and when the address arrives
-- it is filled in and they are invited like anybody else.

alter table attendees alter column email drop not null;

-- Uniqueness still holds for the addresses that exist. A plain UNIQUE would
-- do it in Postgres -- nulls do not collide -- but saying so in a partial
-- index makes the intent legible to the next person reading the schema.
alter table attendees drop constraint attendees_email_key;

create unique index attendees_email_unique
  on attendees (email)
  where email is not null;

-- A row with neither an address nor a name is nobody at all, and would show
-- in the guest list as a blank line with a badge number.
alter table attendees add constraint attendees_have_a_name_or_an_email
  check (
    email is not null
    or coalesce(nullif(trim(first_name), ''), nullif(trim(last_name), '')) is not null
  );

comment on column attendees.email is
  'Null for somebody added before their address was known. They cannot sign '
  'in until it is filled in, and everything else about them works.';
