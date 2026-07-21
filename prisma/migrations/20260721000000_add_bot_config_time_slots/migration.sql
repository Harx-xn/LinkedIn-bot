ALTER TABLE "BotConfig"
ADD COLUMN "timeSlots" JSONB NOT NULL DEFAULT '["09:00"]';

UPDATE "BotConfig"
SET "timeSlots" = '["09:00"]'::jsonb
WHERE jsonb_typeof("timeSlots") <> 'array'
   OR jsonb_array_length("timeSlots") = 0;
