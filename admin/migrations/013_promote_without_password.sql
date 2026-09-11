-- An administrator is somebody who already has an account here, and promotion
-- copies the password they already use. Some of them have not set one yet:
-- invited, on the guest list, never clicked the link.
--
-- There was nowhere to record that. password_hash was NOT NULL, so the only
-- ways to promote such a person were to invent a second password for them --
-- the very thing that left a speaker signing in with the password he knew and
-- being told he was not an admin -- or to refuse until he had set one.
--
-- Null now means what it says: no password yet. verify() already refuses a
-- null hash, so the role grants nothing until they set one, and they are sent
-- the same link the guest list sends.

alter table admin_users alter column password_hash drop not null;

comment on column admin_users.password_hash is
  'Null until this person sets a password. Kept identical to their attendee '
  'password: one address is one person with one credential.';
