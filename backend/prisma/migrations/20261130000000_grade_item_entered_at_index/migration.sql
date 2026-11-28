-- Grades as a digest input: the index the checker rule needs.
--
-- `GradeItem` was indexed `[studentGuid, schoolYear, eventDate]` only, for the
-- per-child list that reads newest assessment first. The digest asks a
-- different question -- which marks were KEYED IN over the last few days --
-- and that is `enteredAt`, which GradesTask writes from the upstream
-- `timestamp` and which sits weeks from `eventDate` on real rows. Under the
-- old index that rule matches on the first two columns and then filters a
-- whole school year of one child's grades in memory, on every run, seven
-- times a day per child.

CREATE INDEX IF NOT EXISTS "grade_item_studentGuid_schoolYear_enteredAt_idx"
  ON "grade_item" ("studentGuid", "schoolYear", "enteredAt");
