/**
 * An event for badges to belong to.
 *
 * A badge belongs to an event now, so a test that issues one needs an event
 * to issue it for. Most of them do not care which -- they are about numbering,
 * or claiming, or the guest list -- so they get this one and say nothing about
 * it.
 *
 * Idempotent, and it puts the event back to live if an earlier test in the
 * same file stood it down. Test files truncate `events` between them, so this
 * cannot be done once at the start of a run.
 */
export const SLUG = "a-test-event";

export async function ensureLiveEvent(db, slug = SLUG) {
  await db.query(
    `insert into events (slug, name, when_label, city, status)
     values ($1, 'A Test Event', 'Next year', 'Somewhere', 'draft')
     on conflict (slug) do nothing`,
    [slug]
  );

  // One live event at a time is a partial unique index, so the previous one
  // has to stand down before this one stands up.
  await db.query("update events set status = 'past' where status = 'live' and slug <> $1", [slug]);
  await db.query("update events set status = 'live' where slug = $1", [slug]);
  return slug;
}
