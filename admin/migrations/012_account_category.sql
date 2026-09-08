-- An account's type is a badge category, not a separate two-value enum.
--
-- It was `role`, checked against 'visitor' or 'speaker'. That predates badge
-- categories being data: VIP existed only as a badge, so the guest list could
-- offer two types while badges came in three, and adding Press or Staff at
-- /admin/categories would have left the account list unable to describe them.
--
-- One source of truth. The type on the account is the category its badge is
-- issued in, and the list of choices is whatever the organisers have set up.

alter table attendees rename column role to category;

alter table attendees drop constraint attendees_role_known;

-- Every existing value -- 'visitor' and 'speaker' -- is already a category, so
-- nothing needs rewriting before the key goes on.
alter table attendees add constraint attendees_category_fkey
  foreign key (category) references badge_categories (slug);

alter index attendees_role rename to attendees_category;

-- A line each category carries onto its badges.
--
-- VIP badges are to say "Pre-event dinner": the holders are invited to it and
-- the door needs to see that without a list. Per category rather than per
-- guest, because it is true of the category.
alter table badge_categories add column note text;

comment on column badge_categories.note is
  'Shown on every badge in this category, on the ticket page and in the wallet '
  'pass. For access that belongs to the category rather than to one guest.';

update badge_categories set note = 'Pre-event dinner' where slug = 'vip';
