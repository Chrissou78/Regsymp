-- A badge is attributed by the organisers and then claimed by the person it
-- belongs to, and those two moments bracket the period in which it can still
-- be changed.
--
-- Before the claim, nothing has been accepted: a cancellation should hand VIP 7
-- to the next person rather than burn one of only 33 places.
--
-- After it, the badge is somebody's. It cannot be renumbered, moved to another
-- guest, or have its number recycled, because they are holding it -- on a
-- phone, in a wallet, or printed. Withdrawing one is still possible (a place
-- can be rescinded) but the number retires with it, so two people can never
-- carry the same one.

alter table tickets add column claimed_at  timestamptz;
alter table tickets add column released_at timestamptz;

comment on column tickets.claimed_at is
  'Set when the attendee accepted the badge in their portal. From that moment '
  'it is fixed: no renumbering, no reassignment, no reuse of its number.';

comment on column tickets.released_at is
  'Set when the number was deliberately returned to the pool for reuse. Only '
  'ever set on a badge that was withdrawn before it was claimed.';

-- The number was unique across every row ever written, which is precisely what
-- made a withdrawn one unusable. It is now unique among the rows that still
-- hold one: active badges, and withdrawn badges whose numbers retired with
-- them. Released rows stay for the record but no longer occupy their number.
alter table tickets drop constraint if exists tickets_number_key;

create unique index tickets_number_held
  on tickets (number)
  where number is not null and released_at is null;

-- A number cannot go back into the pool while the badge is still valid.
alter table tickets add constraint tickets_release_needs_withdrawal
  check (released_at is null or revoked_at is not null);

-- Nor can a claimed badge's number ever be recycled. Enforced here as well as
-- in the store: this is the rule the whole scheme rests on, and a future path
-- into the table must not be able to sidestep it.
alter table tickets add constraint tickets_claimed_numbers_are_kept
  check (released_at is null or claimed_at is null);
