-- Down: 20260406202100_handoff_sequence_autoincrement
-- Reverses: sequence on Handoff.sequence_number → restore plain INTEGER (no default)

ALTER TABLE "Handoff" ALTER COLUMN "sequence_number" DROP DEFAULT;
DROP SEQUENCE IF EXISTS handoff_sequence_number_seq;
