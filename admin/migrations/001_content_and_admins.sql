-- Content documents, keyed by the same paths the file and repository stores
-- used ("src/_data/speakers.json", "src/assets/images/lmax.png"). Keeping the
-- key space identical is what lets the admin's seven collection schemas, and
-- their tests, carry over untouched.
--
-- The body is bytea so JSON and uploaded images share one table: the store
-- above it decides which to decode as text.
create table content_documents (
  path       text        primary key,
  body       bytea       not null,
  is_binary  boolean     not null default false,
  digest     text        not null,
  updated_at timestamptz not null default now(),
  updated_by text
);

-- Committing every edit gave history and rollback for free. Leaving git meant
-- losing that, so it is kept explicitly: the row a save replaces is copied
-- here first, capped per path by the store.
create table content_revisions (
  id            bigserial   primary key,
  path          text        not null,
  body          bytea       not null,
  digest        text        not null,
  superseded_at timestamptz not null default now(),
  updated_by    text
);

create index content_revisions_path_time on content_revisions (path, superseded_at desc);

-- Admin accounts, as a real table rather than a JSON document.
--
-- They were a document while they lived in a git repository, because that was
-- all a repository could hold. Here they get columns: the next subsystem joins
-- attendee profiles onto these rows, and a password hash belongs in a column
-- that can be constrained, not inside a blob.
create table admin_users (
  email                text        primary key,
  password_hash        text        not null,
  is_owner             boolean     not null default false,
  must_change_password boolean     not null default false,
  created_at           timestamptz not null default now(),
  created_by           text,
  password_changed_at  timestamptz
);

-- At most one owner. The owner is the only account that can manage accounts,
-- so two of them is a state the application should never be able to reach.
create unique index admin_users_single_owner on admin_users (is_owner) where is_owner;
