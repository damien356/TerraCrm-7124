-- Who on the crew sees what on a job with more than one crew (Damien, 15 Nov 2026).
--
-- job_materials.task_id and job_media.task_id already say which dispatch a
-- line or a file belongs to. crew_shared is the office's "every crew on this
-- job" tick, for the odd line both crews need. On a job with more than one
-- crew, a line or file with no dispatch and no tick is office only until the
-- office picks one (lib/task-scope.ts). One crew on the job: nothing changes.
--
-- Additive: two new columns that start at 0, and one index. Nothing existing
-- is changed. Fails harmlessly with "duplicate column name" if it has run.
ALTER TABLE `job_materials` ADD `crew_shared` integer DEFAULT 0 NOT NULL;
ALTER TABLE `job_media` ADD `crew_shared` integer DEFAULT 0 NOT NULL;
CREATE INDEX IF NOT EXISTS `materials_task_idx` ON `job_materials` (`task_id`);
