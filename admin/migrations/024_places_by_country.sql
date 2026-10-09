-- The editions name their country first.

-- "Davos" and "Barcelona" read as cities to somebody who already knows the
-- series. To everybody else, country first is the faster read, and two of the
-- six were never cities at all: The North is a region and the Davos edition
-- now spans St Moritz as well. So the label becomes "Country (place)" and
-- carries the detail the old one had to leave out.
--
-- This is the city column rather than a new one: it is what every surface
-- already prints -- the hero's Upcoming line, the strip on the homepage, the
-- cards and the chips on /next -- and they should all say the same thing.
--
-- Guarded on the old value so it cannot overwrite an edit made in the admin
-- between this being written and the server next starting. An edition whose
-- label has already been changed is left exactly as it is.

update events set city = 'UK (London)'                     where slug = 'london-2026'    and city = 'London';
update events set city = 'Switzerland (St Moritz–Davos)'    where slug = 'davos-2027'     and city = 'Davos';
update events set city = 'The North (Sweden / Finland)'     where slug = 'the-north-2027' and city = 'The North';
update events set city = 'Spain (Barcelona)'                where slug = 'barcelona-2027' and city = 'Barcelona';
update events set city = 'Spain (Mallorca)'                 where slug = 'mallorca-2027'  and city = 'Mallorca';

-- Napa moves. The Ninety-Nine's spring edition is New York, not California;
-- the slug, the photograph and the blurb still say Napa and are an editorial
-- job rather than a migration's.
update events set city = 'USA (New York)'                   where slug = 'napa-2027'      and city = 'Napa Valley';
