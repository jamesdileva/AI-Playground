ALTER TABLE gallery_canvases ADD COLUMN caption TEXT NOT NULL DEFAULT '';
ALTER TABLE gallery_plots ADD COLUMN caption TEXT NOT NULL DEFAULT '';
ALTER TABLE gallery_plots ADD COLUMN title TEXT NOT NULL DEFAULT '';
ALTER TABLE canvas_ops ADD COLUMN remixed_from INTEGER;
CREATE INDEX IF NOT EXISTS idx_canvas_ops_epoch_remixed ON canvas_ops(epoch, remixed_from);
