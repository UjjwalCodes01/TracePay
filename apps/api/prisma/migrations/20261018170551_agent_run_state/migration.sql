/*
  Warnings:

  - Added the required column `intent` to the `AgentRun` table without a default value. This is not possible if the table is not empty.
  - Added the required column `selection` to the `AgentRun` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "AgentRun" ADD COLUMN     "intent" JSONB NOT NULL,
ADD COLUMN     "pending" JSONB,
ADD COLUMN     "selection" JSONB NOT NULL,
ADD COLUMN     "summary" TEXT,
ADD COLUMN     "transcript" JSONB NOT NULL DEFAULT '[]';
