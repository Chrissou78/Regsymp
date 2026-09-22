-- Events, because this is not a site about one symposium.
--
-- There was already a notion of an edition: a key, a label and a URL, enough
-- to fill the dropdown in the navigation and nothing else. Everything that
-- actually describes an event -- when it is, where, who is speaking, who is
-- sponsoring, what the homepage says -- was site content with no owner, so
-- there was exactly one event and it was whatever the site currently said.
--
-- An event is a row now. It can be written months ahead, looked at before
-- anybody else sees it, and made live when it is ready.

create table events (
  id         bigserial   primary key,
  slug       text        not null unique,
  name       text        not null,

  -- Where.
  city       text,
  country    text,
  venue      text,

  -- When. A label as well as dates, because "Spring 2027" and
  -- "February / March 2027" are real answers to when an event is and neither
  -- of them is a date. The dates are for ordering and for knowing what has
  -- passed; the label is what people read.
  when_label text        not null,
  starts_on  date,
  ends_on    date,

  -- What it is, in one line and in a few.
  series     text,
  tagline    text,
  summary    text,

  -- draft: being written, visible only to an administrator previewing it.
  -- live:  the event the site is currently about.
  -- past:  it happened.
  status     text        not null default 'draft',

  -- Whether it appears in the "coming next" summary. Not every event that
  -- exists is one to announce.
  upcoming   boolean     not null default true,

  sort       integer     not null default 0,
  created_at timestamptz not null default now(),
  created_by text,
  updated_at timestamptz not null default now(),

  constraint events_status_known check (status in ('draft', 'live', 'past')),
  constraint events_dates_in_order check (ends_on is null or starts_on is null or ends_on >= starts_on)
);

-- One event at a time, said where it cannot be worked around. Making a second
-- one live has to mean standing the first one down, and a rule kept only in
-- the application is a rule that holds until the day somebody writes a script.
create unique index events_one_live on events (status) where status = 'live';

create index events_upcoming on events (sort, starts_on) where upcoming;

comment on column events.status is
  'draft until it is ready, live for the one the site is about, past afterwards.';
