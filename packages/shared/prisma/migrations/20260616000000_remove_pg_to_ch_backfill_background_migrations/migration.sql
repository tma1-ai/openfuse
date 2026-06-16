-- The Postgres -> ClickHouse backfill background migrations (traces / observations / scores /
-- dataset_run_items / dataset_run_items_rmt) populated the legacy ClickHouse projection tables.
-- ClickHouse is retired on the GreptimeDB backend and the migration scripts have been removed,
-- so drop their seed rows to stop the background migration runner from trying to `require` a
-- script file that no longer exists.
DELETE FROM background_migrations
WHERE id IN (
  '5960f22a-748f-480c-b2f3-bc4f9d5d84bc', -- 20241024_1730 migrate traces from pg to ch
  '7526e7c9-0026-4595-af2c-369dfd9176ec', -- 20241024_1737 migrate observations from pg to ch
  '94e50334-50d3-4e49-ad2e-9f6d92c85ef7', -- 20241024_1738 migrate scores from pg to ch
  '8d47f91b-3e5c-4a26-9f85-c12d6e4b9a3d', -- 20250731_1001 migrate dataset_run_items from pg to ch
  '9f32e84c-7b1d-4f59-a803-d67ae5c9b2e8'  -- 20250814_1001 migrate dataset_run_items_rmt from pg to ch
);
