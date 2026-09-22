-- The events that exist today.
--
-- Palma is the one the site is about. The six after it are The 33: the
-- intimate format, thirty-three people at one table, in places chosen for
-- being worth travelling to. They are drafts -- announced in the "coming
-- next" summary, but the site is not about them yet.
--
-- The dates are deliberately loose. "Spring 2027" is the true answer to when
-- Napa is, and writing 2027-03-01 to make a column happy would be inventing a
-- precision nobody has.

insert into events (slug, name, series, city, country, when_label, starts_on, ends_on, tagline, status, upcoming, sort, created_by)
values
  ('palma-2026', 'RegSymp Mallorca', 'The Ninety Nine', 'Palma de Mallorca', 'Spain',
   '14–15 September 2026', date '2026-09-14', date '2026-09-15',
   'An invitation only gathering of 99 senior leaders in financial services.',
   'live', false, 0, 'migration'),

  ('london-2026', 'The 33 · London', 'The 33', 'London', 'United Kingdom',
   'November 2026', date '2026-11-01', null,
   'An intimate private dinner in one of London''s most iconic settings.',
   'draft', true, 1, 'migration'),

  ('davos-2027', 'The 33 · Davos', 'The 33', 'Davos', 'Switzerland',
   'January 2027', date '2027-01-18', null,
   'Thirty-three leaders gathering in the Swiss Alps around the World Economic Forum.',
   'draft', true, 2, 'migration'),

  ('the-north-2027', 'The 33 · The North', 'The 33', 'The North', null,
   'February / March 2027', date '2027-02-01', null,
   'Swedish or Finnish Lapland. Snow, huskies, fireside conversations and the Aurora Borealis.',
   'draft', true, 3, 'migration'),

  ('napa-2027', 'The 33 · Napa Valley', 'The 33', 'Napa Valley', 'United States',
   'Spring 2027', date '2027-04-01', null,
   'A private gathering among vineyards, wine estates and the landscape of Northern California.',
   'draft', true, 4, 'migration'),

  ('barcelona-2027', 'The 33 · Barcelona', 'The 33', 'Barcelona', 'Spain',
   'June 2027', date '2027-06-23', null,
   'A Mediterranean edition around Sant Joan.',
   'draft', true, 5, 'migration'),

  ('mallorca-2027', 'The 33 · Mallorca', 'The 33', 'Mallorca', 'Spain',
   'September 2027', date '2027-09-01', null,
   'The return of RegSymp Mallorca and The 33.',
   'draft', true, 6, 'migration')
on conflict (slug) do nothing;
