-- Settings the running site reads, as opposed to content it is built from.
--
-- Content lives in documents and is compiled into _site by Eleventy. That is
-- right for things that are part of a page and wrong for things the server has
-- to consult on a request: a rebuild is too slow a way to answer "is the site
-- open?", and a value that only exists inside a built page cannot be read
-- before deciding whether to serve that page at all.
--
-- Key and value rather than a column per setting, because the alternative is a
-- migration every time the organisers want one more switch.

create table site_settings (
  key        text        primary key,
  value      jsonb       not null,
  updated_at timestamptz not null default now(),
  updated_by text
);

comment on table site_settings is
  'Runtime settings, read on a request. Content belongs in documents instead.';

-- Between events the site says so rather than showing the last one as though
-- it were still coming.
insert into site_settings (key, value, updated_by)
values (
  'sleep',
  jsonb_build_object(
    'on', false,
    'heading', 'Thank you.',
    'message', 'We are closed for a little while, working on the next experience.'
  ),
  'migration'
);
