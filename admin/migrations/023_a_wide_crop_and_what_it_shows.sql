-- A second crop, and a description of it.
--
-- The 33 is shown two ways and they want different pictures. The cards on
-- /next are squares; the rows on the homepage are letterboxes, and a square
-- cropped into a letterbox loses whatever the photograph was of -- Big Ben
-- becomes a slice of sky and water. So an edition carries both, and each
-- surface asks for the one it can use.
--
-- The alt text comes with them. "London" describes the link, not the picture;
-- "Palace of Westminster and Big Ben at night across the Thames" describes
-- the picture, which is what somebody using a screen reader is missing.

alter table events add column wide_image_path text;
alter table events add column image_alt       text;

comment on column events.wide_image_path is
  'Letterbox crop (about 2400x900) for the homepage strip. Falls back to image_path.';
comment on column events.image_alt is
  'What the photograph shows, for anyone who cannot see it. Not the place name.';
