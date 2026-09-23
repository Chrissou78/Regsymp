-- Paying for a seat.
--
-- A price belongs to an event and a badge category: a VIP seat at Davos is not
-- a VIP seat at Mallorca, and the speaker seat at either may be free or may not
-- exist at all. No price means not for sale, which is the default and the right
-- one -- a category that nobody has priced should not quietly go on sale.
--
-- Payments are recorded here rather than only at Stripe. Stripe knows what was
-- charged; this needs to know which badge it bought, and to be able to answer
-- that without a network call.

create table event_prices (
  id         bigserial   primary key,
  event_slug text        not null references events (slug) on delete cascade,
  category   text        not null references badge_categories (slug),

  -- Minor units, as Stripe counts: 50000 is five hundred euro. Storing money
  -- as a decimal invites a rounding argument nobody wins.
  amount     integer     not null,
  currency   text        not null default 'eur',

  -- Priced is not the same as on sale. A price can be set in advance and the
  -- seats opened later.
  on_sale    boolean     not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint event_prices_amount_sane check (amount > 0 and amount < 100000000),
  constraint event_prices_currency_shape check (currency ~ '^[a-z]{3}$'),
  unique (event_slug, category)
);

create table payments (
  id            bigserial   primary key,

  -- The Stripe checkout session. Unique, so a webhook delivered twice cannot
  -- produce two payments -- Stripe retries for three days and says plainly
  -- that an endpoint may see the same event more than once.
  session_id    text        not null unique,
  stripe_event  text,

  event_slug    text        references events (slug),
  category      text        references badge_categories (slug),

  email         text,
  name          text,
  amount        integer     not null,
  currency      text        not null,

  -- pending until Stripe says otherwise. A pending row is a person who opened
  -- the payment page; most of them are not a problem, they simply changed
  -- their mind.
  status        text        not null default 'pending',

  attendee_id   bigint      references attendees (id) on delete set null,
  ticket_id     bigint      references tickets (id) on delete set null,

  created_at    timestamptz not null default now(),
  paid_at       timestamptz,

  constraint payments_status_known check (status in ('pending', 'paid', 'failed', 'expired'))
);

create index payments_by_event on payments (event_slug, status);
create index payments_by_email on payments (lower(email));

comment on table event_prices is
  'What a seat costs, per event and badge category. No row means not for sale.';
comment on column payments.session_id is
  'The Stripe checkout session, unique so a redelivered webhook cannot pay twice.';
