-- Each source passage is screened once for text that tries to instruct AI systems.

-- AlterTable
ALTER TABLE "SourceChunk" ADD COLUMN     "instructsAi" BOOLEAN,
ADD COLUMN     "screenNote" TEXT,
ADD COLUMN     "screenedBy" TEXT;

