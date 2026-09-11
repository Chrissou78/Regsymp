-- Every administrator is a person, and a person has a profile.
--
-- The two tables grew apart: admin_users came first, attendees arrived with
-- the guest list, and nothing ever said that the same human might be in both.
-- So the site had administrators with no profile to go to -- no badge, no
-- details, nothing to edit -- and the admin could offer them no way back to
-- themselves, because there was no themselves to go back to.
--
-- Promotion now starts from the guest list, so anybody made an administrator
-- from here on already has one. This is for the ones who were there first.
--
-- The password comes across with them, because one address is one person with
-- one credential. Names are left empty on purpose: the profile page is where
-- somebody says who they are, and inventing "Christopher Fourquier" from the
-- half of an address before the @ would be a guess that looks like a fact.

insert into attendees (email, category, password_hash, claimed_at, self_registered, created_by, created_at)
select u.email,
       'visitor',
       u.password_hash,
       case when u.password_hash is not null then coalesce(u.created_at, now()) end,
       false,
       'promoted from the admin list',
       coalesce(u.created_at, now())
  from admin_users u
  left join attendees a on a.email = u.email
 where a.id is null;

-- No badge is issued here. Being an administrator is not being a guest, and
-- which badge they should carry -- if any -- is a decision for the guest list.
