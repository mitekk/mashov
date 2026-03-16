-- CreateTable
CREATE TABLE "timetable_entry" (
    "id" TEXT NOT NULL,
    "studentGuid" TEXT NOT NULL,
    "groupId" INTEGER NOT NULL,
    "day" INTEGER NOT NULL,
    "lesson" INTEGER NOT NULL,
    "roomNum" TEXT NOT NULL DEFAULT '',
    "weeks" INTEGER NOT NULL DEFAULT -1,
    "groupName" TEXT NOT NULL,
    "subjectName" TEXT NOT NULL,
    "teachers" JSONB NOT NULL DEFAULT '[]',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "timetable_entry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "timetable_entry_studentGuid_idx" ON "timetable_entry"("studentGuid");

-- CreateIndex
CREATE UNIQUE INDEX "timetable_entry_studentGuid_day_lesson_key" ON "timetable_entry"("studentGuid", "day", "lesson");
