-- Review UI: ONE message with a list of recipients (scales past a handful of people),
-- instead of one message per draft plus a summary.
ALTER TABLE events RENAME COLUMN summary_message_id TO review_message_id;
ALTER TABLE events ADD COLUMN open_invitation_id BIGINT; -- which draft that message currently shows
ALTER TABLE invitations DROP COLUMN review_message_id;

-- What the single Google Maps call for this event found about the chosen place: {text, sources[]}.
-- Invitations are written by comparing these facts with each recipient's profile (no further Maps calls).
ALTER TABLE events ADD COLUMN venue_facts JSONB;
