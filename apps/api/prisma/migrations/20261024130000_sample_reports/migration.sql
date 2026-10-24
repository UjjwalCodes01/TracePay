-- A demo world's ready-made sample report: listed in its store, not counted as the publisher's own progress.

-- AlterTable
ALTER TABLE "BuildJob" ADD COLUMN     "sample" BOOLEAN NOT NULL DEFAULT false;
