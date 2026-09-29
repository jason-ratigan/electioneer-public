-- Preserve source decimal precision instead of rounding published percentages.
ALTER TABLE poll_responses ALTER COLUMN share TYPE NUMERIC;
ALTER TABLE published_poll_averages ALTER COLUMN share TYPE NUMERIC;
