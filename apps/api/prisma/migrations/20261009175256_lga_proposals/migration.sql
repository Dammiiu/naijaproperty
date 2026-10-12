-- AlterTable
ALTER TABLE "lgas" ADD COLUMN     "is_active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "proposal_count" INTEGER NOT NULL DEFAULT 0;
