-- Issue #73: a ~400px WebP thumbnail per image, for Browse rows and the
-- recipe photo strip. Nullable: uploads before this migration get one from
-- the thumbnail backfill (POST /api/v1/images/thumbnails/backfill), and until
-- then readers fall back to the display copy. Altered, not rebuilt, for the
-- same reason as 003: recipe.cover_image_id references image.
ALTER TABLE image ADD COLUMN r2_key_thumb TEXT;
