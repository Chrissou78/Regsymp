-- Badge categories, as data rather than as a constraint.
--
-- They started as a CHECK on tickets.tier: 'vip' or 'general', with the
-- 1-33/34-100 mapping written into SQL. That made the rule unbreakable, which
-- was the point -- but it also made adding "Press" or "Staff" a migration.
-- Categories the organisers can add and remove have to be rows.
--
-- The number range moves with them, and is optional. Speakers start
-- unnumbered; giving them their own series later is a setting, not a schema
-- change.
create table badge_categories (
  slug        text        primary key,
  label       text        not null,
  number_from integer,
  number_to   integer,
  -- Printed on the badge, so the categories are told apart across a room.
  colour      text        not null default '#1C2B4A',
  sort        integer     not null default 0,
  -- The three the event is built around. Removing them would strand tickets
  -- and break the speaker portal, so they cannot be deleted -- only edited.
  protected   boolean     not null default false,
  created_at  timestamptz not null default now(),

  constraint badge_categories_range check (
    (number_from is null and number_to is null) or
    (number_from is not null and number_to is not null and number_from <= number_to)
  )
);

insert into badge_categories (slug, label, number_from, number_to, colour, sort, protected) values
  ('speaker', 'Speaker',  null, null, '#B8963A', 1, true),
  ('vip',     'VIP',         1,   33, '#1C2B4A', 2, true),
  ('visitor', 'Visitor',    34,  100, '#6B7FA0', 3, true);

-- Tickets point at a category instead of carrying a hardcoded tier.
alter table tickets add column category text references badge_categories (slug);

-- Carry across anything already issued. 'general' was what 'visitor' is now.
update tickets set category = case when tier = 'vip' then 'vip' else 'visitor' end;

alter table tickets alter column category set not null;
alter table tickets drop constraint tickets_number_matches_tier;
alter table tickets drop constraint tickets_tier_known;
alter table tickets drop column tier;

-- Unnumbered categories exist, so a number is now optional -- but still
-- unique across the event when present, which is what stops two people
-- being handed the same one.
alter table tickets alter column number drop not null;

/*
 * The range rule survives the move to data.
 *
 * A CHECK constraint cannot read another table, so this is a trigger. Worth
 * the machinery: it was enforced in the database precisely so that a caller
 * who forgets the rule -- or a category edited later -- cannot quietly issue
 * a number outside its range.
 */
create or replace function tickets_number_within_category() returns trigger as $$
declare
  bounds badge_categories;
begin
  select * into bounds from badge_categories where slug = new.category;
  if not found then
    raise exception 'unknown badge category %', new.category;
  end if;

  if new.number is null then
    if bounds.number_from is not null then
      raise exception 'category % is numbered, so a ticket needs a number', new.category;
    end if;
    return new;
  end if;

  if bounds.number_from is null then
    raise exception 'category % is unnumbered, so a ticket cannot carry number %',
      new.category, new.number;
  end if;

  if new.number < bounds.number_from or new.number > bounds.number_to then
    raise exception 'number % is outside the % range (% to %)',
      new.number, new.category, bounds.number_from, bounds.number_to;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger tickets_number_in_range
  before insert or update of number, category on tickets
  for each row execute function tickets_number_within_category();
