-- Job 4297 (quote 81, dispatch 69): the stairs line, approved by Damien (7 Nov 2026).
-- Quote line 560 "Install carpet tiles to steps inc aluminium nosing install", 30 each, had no
-- rate item, so it only sat in the dispatch notes and paid the installer nothing.
--
-- 1. Quote line 560 is linked to rate item 8 "Carpet stairs, standard straight step" (per step).
--    Only the link changes: the customer's price ($55 each, $1,650) and the quote totals stay.
-- 2. Dispatch 69 gets the labour line: item 8, 30 steps. Paid at the installer's own rate for
--    item 8 when he has one, otherwise Terra's standard ($13.00 a step today), priced when the
--    work is booked. The nosing install is part of this line: no separate nosing pay is added
--    (item 67 "Nosing supply and fit" is not put on, and the stair/nosing check stops it).
-- 3. The "Also on the quote" note on dispatch 69 is cleared, as the line is now real work.
-- 4. A line in the job's history says what was done and why.
--
-- Only runs while dispatch 69 is unassigned, unpriced, not offered and not invoiced, so
-- nothing already invoiced or paid is rewritten. Running it twice changes nothing.
UPDATE quote_items SET rate_item_id = 8 WHERE id = 560 AND quote_id = 81 AND rate_item_id IS NULL AND kind = 'labour' AND qty = 30 AND description = 'Install carpet tiles to steps inc aluminium nosing install';
--> statement-breakpoint
INSERT INTO task_labour_lines (task_id, item_id, qty, note, sort_order, created_at, updated_at)
SELECT 69, 8, 30, 'Quote line 560: carpet tiles to steps, aluminium nosing install included. No separate nosing pay.', (SELECT coalesce(max(sort_order), 0) + 1 FROM task_labour_lines WHERE task_id = 69), cast(strftime('%s','now') as integer), cast(strftime('%s','now') as integer)
WHERE EXISTS (SELECT 1 FROM quote_items WHERE id = 560 AND quote_id = 81 AND rate_item_id = 8)
  AND EXISTS (SELECT 1 FROM job_tasks WHERE id = 69 AND job_id = 4297 AND status = 'unassigned' AND assigned_installer_id IS NULL AND labour_cost IS NULL)
  AND NOT EXISTS (SELECT 1 FROM task_labour_lines WHERE task_id = 69 AND item_id IN (8, 67))
  AND NOT EXISTS (SELECT 1 FROM task_offers WHERE task_id = 69)
  AND NOT EXISTS (SELECT 1 FROM installer_invoices WHERE task_id = 69);
--> statement-breakpoint
UPDATE job_tasks SET description = NULL, updated_at = cast(strftime('%s','now') as integer) WHERE id = 69 AND description = 'Also on the quote: Install carpet tiles to steps inc aluminium nosing install (30 each).' AND EXISTS (SELECT 1 FROM task_labour_lines WHERE task_id = 69 AND item_id = 8 AND qty = 30);
--> statement-breakpoint
INSERT INTO activity_log (job_id, task_id, entity_type, entity_id, action, detail, actor_name, actor_role, created_at)
SELECT 4297, 69, 'task', 69, 'labour_line_linked', 'Stairs line (Install carpet tiles to steps inc aluminium nosing install, 30) linked to Carpet stairs, standard straight step, 30 steps, nosing install included. Approved by Damien Lacey, 7 Nov 2026.', 'Damien Lacey', 'admin', cast(strftime('%s','now') as integer)
WHERE EXISTS (SELECT 1 FROM task_labour_lines WHERE task_id = 69 AND item_id = 8 AND qty = 30)
  AND NOT EXISTS (SELECT 1 FROM activity_log WHERE task_id = 69 AND action = 'labour_line_linked');
