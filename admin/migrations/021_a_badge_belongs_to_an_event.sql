-- A badge belongs to an event.
--
-- Until now the site was about one event and a badge could simply be a badge.
-- It cannot any more: the same person may hold VIP 7 at Palma and VIP 7 at
-- Davos, buy a seat at both, and redeem each when its event comes round. Two
-- rules were written on the assumption of a single event and both are wrong
-- now:
--
--   - one badge per person. It is one badge per person *per event*.
--   - one holder per number. It is one holder per number *per event*, or
--     numbering would run out across the series instead of starting again.
--
-- Everything already issued belongs to the event the site is currently about,
-- which is the only event there has ever been.

alter table tickets add column event_slug text references events (slug);

update tickets
   set event_slug = (select slug from events where status = 'live')
 where event_slug is null;

-- Loud rather than lenient. A badge with no event cannot be checked in, cannot
-- be numbered and cannot be reasoned about, so a row that could not be placed
-- is a migration that should stop rather than one that should shrug.
alter table tickets alter column event_slug set not null;

-- Numbers start again at each event. The old index made VIP 7 unique across
-- the whole series, which would have quietly exhausted the range.
drop index if exists tickets_number_held;
create unique index tickets_number_held
    on tickets (event_slug, number)
 where number is not null and released_at is null;

-- One badge per person per event, in the schema rather than only in the code
-- that issues them.
create unique index tickets_one_per_event
    on tickets (event_slug, attendee_id)
 where revoked_at is null;

create index tickets_by_event on tickets (event_slug);

comment on column tickets.event_slug is
  'The event this badge admits its holder to. Numbers and the one-badge rule are per event.';
