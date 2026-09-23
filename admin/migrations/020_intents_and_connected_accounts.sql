-- Payment intents, and whose account the money went into.
--
-- The checkout session is how somebody paid; the payment intent is what they
-- paid. It is the id Stripe's dashboard shows, the id a dispute quotes and the
-- id a refund is issued against, and a session is a poor substitute for it --
-- so it is recorded here rather than looked up over the network by whoever is
-- trying to answer a question about one payment.
--
-- The charge id comes with it because a refund arrives as a charge event and
-- has to find its way back to a row.
--
-- And the connected account, when there is one. Seats can be sold into an
-- account that is not this platform's, and a payment that does not say which
-- account took the money is a payment nobody can reconcile.

alter table payments
  add column payment_intent text,
  add column charge_id      text,
  add column stripe_account text,
  add column refunded_at    timestamptz;

-- Money can come back. Until now the states ran one way, which meant a refund
-- had nowhere to be recorded and the takings would go on counting it.
alter table payments drop constraint payments_status_known;
alter table payments add constraint payments_status_known
  check (status in ('pending', 'paid', 'failed', 'expired', 'refunded'));

-- A refund arrives as a charge event carrying its payment intent, not its
-- session, so this is the way back to the row.
create index payments_by_intent on payments (payment_intent);

comment on column payments.payment_intent is
  'The Stripe payment intent. What a refund and a dispute are issued against.';
comment on column payments.stripe_account is
  'The connected account the money went into, or null for this platform''s own.';
