-- AlterTable: make sequence_number auto-increment so the DB assigns it atomically.
-- The SELECT setval() call advances the sequence past any existing rows so new
-- inserts never collide with pre-migration data.
CREATE SEQUENCE handoff_sequence_number_seq;
ALTER TABLE "Handoff" ALTER COLUMN "sequence_number" SET DEFAULT nextval('handoff_sequence_number_seq');
ALTER SEQUENCE handoff_sequence_number_seq OWNED BY "Handoff"."sequence_number";
SELECT setval('handoff_sequence_number_seq', COALESCE((SELECT MAX("sequence_number") FROM "Handoff"), 0) + 1);
