-- The 33, as a page somebody would want to look at.
--
-- Two things it needs that the events table did not have.
--
-- A picture. Six square photographs are the page: the dates and the one-line
-- blurbs were already here, and a grid of text was never going to say
-- "extraordinary places". The path is a column rather than a convention like
-- `the33/<slug>.jpg`, because the organisers will swap these one at a time and
-- a convention would make that a deploy.
--
-- And somewhere to put the answers. The 33 is by invitation, so the card does
-- not sell a seat -- it registers interest, and the programme chairs decide.
-- That is a different thing from a ticket and from an invitation request, and
-- it belongs in its own table rather than being squeezed into either.

alter table events add column image_path text;

-- The placeholders shipped with the design. From Wikimedia Commons, graded to
-- one treatment; they carry an attribution requirement and are to be replaced
-- before launch, which is said on the page itself as well as here.
update events set image_path = 'the33/' || slug || '.jpg'
 where slug in (
   'london-2026', 'davos-2027', 'the-north-2027',
   'napa-2027', 'barcelona-2027', 'mallorca-2027'
 );

create table the33_interest (
  id         bigserial   primary key,

  name       text        not null,
  email      text        not null,
  company    text        not null,

  -- Which editions they asked about. An array rather than a row each: it is
  -- one act by one person, and reading it back as one row is how anybody will
  -- want to answer "who wants Davos".
  editions   text[]      not null default '{}',

  note       text,
  -- Where the form was submitted from, for telling a card click apart from a
  -- link somebody was sent.
  source     text,

  -- What the chairs have done about it. Nothing is automatic here: an
  -- invitation is a decision by a person, which is the whole point.
  status     text        not null default 'new',
  handled_by text,
  handled_at timestamptz,

  created_at timestamptz not null default now(),

  constraint the33_interest_status_known
    check (status in ('new', 'invited', 'declined', 'archived'))
);

create index the33_interest_recent on the33_interest (created_at desc);
create index the33_interest_by_email on the33_interest (lower(email));
-- Answers "who asked about Davos" without reading every row.
create index the33_interest_editions on the33_interest using gin (editions);

comment on table the33_interest is
  'People who asked to be considered for The 33. Not a booking: the chairs invite.';
comment on column events.image_path is
  'Square photograph for the edition card, relative to /assets/images/.';
