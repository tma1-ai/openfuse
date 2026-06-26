/*
  Warnings:

  - You are about to drop the `cloud_spend_alerts` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `cloud_free_tier_usage_threshold_state` column from `organizations`.

*/
-- DropColumn
ALTER TABLE "organizations" DROP COLUMN "cloud_free_tier_usage_threshold_state";

-- DropTable
DROP TABLE "cloud_spend_alerts";
