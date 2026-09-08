-- Sessions, so a deploy does not sign everybody out.
--
-- They were in memory, which was defensible when a restart was rare. It
-- stopped being defensible the moment the navigation started showing an
-- "Admin" link from a cookie that outlived the server: after every deploy the
-- menu said you were signed in and the first click sent you to the sign-in
-- page.
create table sessions (
  id         text        primary key,
  -- 'admin' or 'guest'. One table, two populations, so signing out of one
  -- cannot reach into the other.
  kind       text        not null,
  subject    jsonb       not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),

  constraint sessions_kind_known check (kind in ('admin', 'guest'))
);

create index sessions_expiry on sessions (expires_at);
create index sessions_kind_subject on sessions (kind, (subject ->> 'email'));
