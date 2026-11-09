-- Document privacy (Damien's urgent brief, 9 Nov 2026).
-- A job file now has a category (its bucket, as before) and, separately, who
-- may see it. The crew only get rows marked "crew" that are not restricted,
-- on a job they hold a task on. See lib/file-access.ts.
--
-- 1. job_media gets visibility, sensitivity, restrict_reason, review_status,
--    classify_note, classified_at, source_message_id, content_sha256,
--    reviewed_by_name, reviewed_at. The column default is office only, needs
--    review, so a new row is private until something says otherwise.
-- 2. access_note_proposals: a client's emailed or texted access instructions
--    wait here for the office. Nothing reaches the job's access notes until
--    someone approves it, and the notes as they were are kept on the row.
-- 3. Backfill of the 119 rows that existed at the 9 Nov audit (ids up to 143),
--    from that audit. Crew photos and files the office put on a job itself
--    stay crew visible, as they are today. Files that came in by email, or
--    went out by email, wait for the office. Three returned Terra quotes
--    (media 126, 137, 142) and one photo of a payment confirmation (45) are
--    restricted. Email logos and signatures are kept office only.
--    Two lockbox photos (47, 96), three screenshots that show access notes
--    (22, 23, 24) and a photo of a draft measure (127) wait for the office.
--    Any row added after the audit keeps the private default.
-- 4. Stopgap until Publish: 126, 137 and 45 are archived, because the code
--    running now only hides archived rows. 142 is already archived. The
--    office can unarchive them after Publish; they stay restricted.
-- 5. Activity entries for the containment: storage made private, and each
--    restricted file. No codes, prices or file contents in them.
--
-- Additive only. Nothing is deleted. No file, email, quote, invoice, price,
-- task, pay or booking is changed.
ALTER TABLE job_media ADD COLUMN visibility text DEFAULT 'office' NOT NULL;
--> statement-breakpoint
ALTER TABLE job_media ADD COLUMN sensitivity text DEFAULT 'unknown' NOT NULL;
--> statement-breakpoint
ALTER TABLE job_media ADD COLUMN restrict_reason text;
--> statement-breakpoint
ALTER TABLE job_media ADD COLUMN review_status text DEFAULT 'needs_review' NOT NULL;
--> statement-breakpoint
ALTER TABLE job_media ADD COLUMN classify_note text;
--> statement-breakpoint
ALTER TABLE job_media ADD COLUMN classified_at integer;
--> statement-breakpoint
ALTER TABLE job_media ADD COLUMN source_message_id integer;
--> statement-breakpoint
ALTER TABLE job_media ADD COLUMN content_sha256 text;
--> statement-breakpoint
ALTER TABLE job_media ADD COLUMN reviewed_by_name text;
--> statement-breakpoint
ALTER TABLE job_media ADD COLUMN reviewed_at integer;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `access_note_proposals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer NOT NULL,
	`source_message_id` integer,
	`channel` text DEFAULT 'email' NOT NULL,
	`from_name` text DEFAULT '' NOT NULL,
	`text` text NOT NULL,
	`media_ids` text DEFAULT '[]' NOT NULL,
	`conflicts` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`previous_notes` text,
	`decided_by_name` text,
	`decided_at` integer,
	`dedupe_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `access_note_proposals_job_idx` ON `access_note_proposals` (`job_id`,`status`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `access_note_proposals_dedupe` ON `access_note_proposals` (`dedupe_key`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `media_sha_idx` ON `job_media` (`content_sha256`);
--> statement-breakpoint
-- Returned Terra quotes Q188003, Q188071, Q188016. Expect 3.
UPDATE job_media SET visibility = 'office', sensitivity = 'restricted', restrict_reason = 'customer_quote', review_status = 'kept_office', classify_note = 'Terra quote with prices, returned by email. Never for the crew', classified_at = unixepoch() WHERE id IN (126, 137, 142) AND classified_at IS NULL AND id <= 143;
--> statement-breakpoint
-- Photo of a screen showing a quote as paid. Expect 1.
UPDATE job_media SET visibility = 'office', sensitivity = 'restricted', restrict_reason = 'payment', review_status = 'kept_office', classify_note = 'Photo of a payment confirmation. Never for the crew', classified_at = unixepoch() WHERE id = 45 AND classified_at IS NULL AND id <= 143;
--> statement-breakpoint
-- Email logos and signatures filed as photos. Expect 7.
UPDATE job_media SET visibility = 'office', sensitivity = 'normal', review_status = 'kept_office', classify_note = 'Email logo or signature, not a job photo', classified_at = unixepoch() WHERE id IN (32, 35, 36, 42, 43, 44, 62) AND classified_at IS NULL AND id <= 143;
--> statement-breakpoint
-- Site access codes and a draft measure. Expect 6.
UPDATE job_media SET visibility = 'office', sensitivity = 'normal', review_status = 'needs_review', classify_note = CASE WHEN id IN (47, 96) THEN 'Lockbox photo. Only for the crew on this job, once the office has checked it' WHEN id = 127 THEN 'Photo of a draft measure on a tablet. Office to check for prices' ELSE 'Screenshot shows site access notes. Office to check before the crew see it' END, classified_at = unixepoch() WHERE id IN (22, 23, 24, 47, 96, 127) AND classified_at IS NULL AND id <= 143;
--> statement-breakpoint
-- Everything else that came in by email. Expect 12.
UPDATE job_media SET visibility = 'office', sensitivity = 'unknown', review_status = 'needs_review', classify_note = CASE WHEN id = 37 THEN 'Password protected PDF, could not be read. Office to check' WHEN mime LIKE 'application/%' AND id IN (34, 64, 81, 122, 131) THEN 'PDF with no readable text. Office to check before the crew see it' WHEN id = 33 THEN 'Came in by email. Same file as the office plan already on this job (media 30)' ELSE 'Came in by email. Office to check before the crew see it' END, classified_at = unixepoch() WHERE uploaded_by_installer_id IS NULL AND uploaded_by_profile_id IS NULL AND caption LIKE 'Emailed by%' AND classified_at IS NULL AND id <= 143;
--> statement-breakpoint
-- Files the office sent out by email. Expect 5.
UPDATE job_media SET visibility = 'office', sensitivity = 'unknown', review_status = 'needs_review', classify_note = 'Sent out by email. Office to check before the crew see it', classified_at = unixepoch() WHERE caption = 'Sent by email' AND classified_at IS NULL AND id <= 143;
--> statement-breakpoint
-- Crew uploads stay crew visible. Expect 18.
UPDATE job_media SET visibility = 'crew', sensitivity = 'normal', review_status = 'approved', classify_note = 'Crew photo, kept as it was', classified_at = unixepoch() WHERE uploaded_by_installer_id IS NOT NULL AND classified_at IS NULL AND id <= 143;
--> statement-breakpoint
-- Files the office put on the job itself stay crew visible. Expect 59.
UPDATE job_media SET visibility = 'crew', sensitivity = 'normal', review_status = 'approved', classify_note = CASE WHEN id IN (16, 28, 31, 41) THEN 'Office plan, kept as it was. Has a Sell Price column, all 0.00: office to confirm' WHEN id = 46 THEN 'Office plan scan, kept as it was' ELSE 'Put on the job by the office, kept as it was' END, classified_at = unixepoch() WHERE uploaded_by_profile_id IS NOT NULL AND uploaded_by_installer_id IS NULL AND classified_at IS NULL AND id <= 143;
--> statement-breakpoint
-- Enquiry form damage photos stay crew visible. Expect 8.
UPDATE job_media SET visibility = 'crew', sensitivity = 'normal', review_status = 'approved', classify_note = 'Damage photo from the enquiry form, kept as it was', classified_at = unixepoch() WHERE uploaded_by_installer_id IS NULL AND uploaded_by_profile_id IS NULL AND bucket = 'damage' AND caption NOT LIKE 'Emailed by%' AND classified_at IS NULL AND id <= 143;
--> statement-breakpoint
-- The email each inbound file came in on. Expect 23.
UPDATE job_media SET source_message_id = CASE id WHEN 32 THEN 30 WHEN 33 THEN 30 WHEN 34 THEN 30 WHEN 35 THEN 28 WHEN 36 THEN 33 WHEN 37 THEN 34 WHEN 42 THEN 47 WHEN 43 THEN 46 WHEN 44 THEN 45 WHEN 45 THEN 59 WHEN 50 THEN 86 WHEN 62 THEN 94 WHEN 63 THEN 94 WHEN 64 THEN 99 WHEN 67 THEN 110 WHEN 68 THEN 110 WHEN 81 THEN 98 WHEN 122 THEN 102 WHEN 126 THEN 204 WHEN 130 THEN 208 WHEN 131 THEN 209 WHEN 137 THEN 303 WHEN 142 THEN 317 END WHERE source_message_id IS NULL AND id IN (32, 33, 34, 35, 36, 37, 42, 43, 44, 45, 50, 62, 63, 64, 67, 68, 81, 122, 126, 130, 131, 137, 142);
--> statement-breakpoint
-- File fingerprints from the audit download. Expect 119.
UPDATE job_media SET content_sha256 = CASE id WHEN 1 THEN '71c00c621a46f7141d8a2ad65cb976d4ecd01e51db8571592f02d0658fd3501b' WHEN 6 THEN 'd679d76a092eb3fe6f0a60cd9f64cd57bead6859774360456b60dee773248c33' WHEN 7 THEN '91ce4b7a0973e7c780e04d4c5b4a1ef44c20fe82e509d4e28ee198bff7d9e910' WHEN 8 THEN '3bca1e2bc04d44227cc4f1080dedf6df2f91b9b477c09ba51399db0338b18a97' WHEN 9 THEN '1ee378350c5df8d53fde3b8c22e95b001dc8ec852519b0ee27f1d6350edffa6f' WHEN 10 THEN 'b43a4f5efb779a1e4a701ab2f9142474a1160a5c52f64ad24aee38bd35b2b677' WHEN 11 THEN '460bf055b361f09c846c4fe010fcaae6e8f1fc4ade1947bc394e045d2dd354da' WHEN 12 THEN 'c050457633e2dcc7e6575fdb4415d0e37a28e711ad82e927ce4ccb4cde1d0997' WHEN 13 THEN '041241afceed95543b15e3801451d606180432f2f43a6b054934cb17a83da710' WHEN 14 THEN '1377e5fe9144d1e2a2204fc2b3f0edfa2d0809da3db6e914a01f2980b476465c' WHEN 15 THEN '5a33e71d6055db1d7f3f15e479baf4b2e8919e3409f5ac59208e5901336b4c10' WHEN 16 THEN 'a27fe37659f54eae40c96498ab2d616a7642bb6039fa3a5fb9ca2587daf93d09' WHEN 17 THEN 'eb92513e72cb5a778a2b304a0e84beeb6a226bd5ee0fe0ea603003eb068214b1' WHEN 18 THEN '1705c5ae582005d331b04350ce73b808979f8647d06eff7164e22d33e089fec6' WHEN 19 THEN '5fab4b98169435246fa5552b220915d07e5e1a9ed66c811c36871277e95d0799' WHEN 20 THEN '1de48d9d68b2497de5a5a2c7f753c4890998ed2d6e845a47d64dcfe69ac5a162' WHEN 21 THEN '0ad85b55f2e92c64e2c22e5fb535ad44565d63d39e7eb0592af9951381bea51d' WHEN 22 THEN '3256452f2fc52ece52f252a787b1595f4a47b089ad42a6fd0184b99b4b7f8911' WHEN 23 THEN '3256452f2fc52ece52f252a787b1595f4a47b089ad42a6fd0184b99b4b7f8911' WHEN 24 THEN '3256452f2fc52ece52f252a787b1595f4a47b089ad42a6fd0184b99b4b7f8911' WHEN 25 THEN 'a4694dd2d31b4d92913c6a67ed0547095883c67e86ac7acde90c82db085a4c01' WHEN 26 THEN '6471f4b418b9bcd2ec907f523169abf091460bbb34e20edba633e51f40bc7c1e' WHEN 27 THEN '6471f4b418b9bcd2ec907f523169abf091460bbb34e20edba633e51f40bc7c1e' WHEN 28 THEN '30d99cb39807b5714d4c17bba3e62da6d4fe83f9c008988232f5f876ff7491fa' WHEN 29 THEN 'd83afcbfd5c8fd2e4c217b74248efd23f143fa7489bca31dea538774e2f5f539' WHEN 30 THEN '98f6581deb1343f157d7715b03a2325e72c537057bafd972bea8b34a29d0338a' WHEN 31 THEN '67dfd0e55461945477036b3140758a3dba3b520eb667d24fe95743917669703e' WHEN 32 THEN '4a80c68a4cfd761912cd58b3020299a2e382d2f5f70102246ba0eb6be1b79563' WHEN 33 THEN '98f6581deb1343f157d7715b03a2325e72c537057bafd972bea8b34a29d0338a' WHEN 34 THEN '8c34240cfe8054e5291c436d6ef90f08ccd850ff849e72df05331c159f11f353' WHEN 35 THEN 'adfaec9790aded9498915c934bc2f5057dd03dee0d4f6c2991856d19919800fa' WHEN 36 THEN 'adfaec9790aded9498915c934bc2f5057dd03dee0d4f6c2991856d19919800fa' WHEN 37 THEN '6521db0dcbf433daa102179a1fb5ad7dee8d8de9c6cb7019ffcee3c2e3427ed9' WHEN 38 THEN 'b621fc8fd263ff478d95510944109dffa17b86566eb8f700fbbcc7e28ff2f3f0' WHEN 39 THEN 'f68a909e61ad332c5259cdf0b846d71e7228311280a34f713eb0658d0d841b00' WHEN 40 THEN 'f68a909e61ad332c5259cdf0b846d71e7228311280a34f713eb0658d0d841b00' WHEN 41 THEN '0b7cb999563b288da9c673bfb604aa37cd985c1372ea6c41d2e3cc4d76a9664c' WHEN 42 THEN 'adfaec9790aded9498915c934bc2f5057dd03dee0d4f6c2991856d19919800fa' WHEN 43 THEN 'adfaec9790aded9498915c934bc2f5057dd03dee0d4f6c2991856d19919800fa' WHEN 44 THEN 'adfaec9790aded9498915c934bc2f5057dd03dee0d4f6c2991856d19919800fa' WHEN 45 THEN 'e92715d1b0d1c27427f421e9d4a393452f638a2449d289b464eb235ecd0bfd90' WHEN 46 THEN 'db2883a9177e9741e9ee97bcd4a6ffff3fece5779843a8fdf3e0d99c20c318d7' WHEN 47 THEN '94c0efa79fa7dd4bc4d042399883779bc737688cc824a7e19c7ad97303ca4e5c' WHEN 48 THEN '443840cce2d6f8925314ce77a50f72c7fee28a67cce84b2ac259ecdfc3cf7218' WHEN 49 THEN 'c6b205902ccaaee052d44030afb487bcb898c88924cb8606cfe1a94ec2518687' WHEN 50 THEN 'e95c56b13c5e700bb573b8cc6eb203327c58f666e2bcc3f9d4566ca196ee4520' WHEN 51 THEN 'b7a4ee0d9850011789e0c591cf37f261a8b5dc5dbb42dee5a71f5b81bb4bb157' WHEN 52 THEN 'ac397b35c890e1ea04c015962befe2ebd91bf435620002069c2271c6ee38c8e7' WHEN 53 THEN 'b0e3465c2ada20cda9ecb43949b05b08d10affa2a4dbd5db8d8827b9cda7da78' WHEN 54 THEN '2e22a5812290a7f4655f234a3b350652f238ec8bdc4d80f9c26a2c69d223894a' WHEN 55 THEN '16dbcc17a4d0e6a4392c832672271f6fff0ca41f0bef4ca041efb85d7738db83' WHEN 56 THEN '2ede52f0dce1ee1157d0296ef33b7e00a868bdd89c785a54ea85f5f1f0a423dc' WHEN 57 THEN '05aa7f355c17c3bdcd1ea5ed96641aa6256e5bae8f5158656e43d74501062ca3' WHEN 58 THEN '7d0f561f49af366d3f21ad3573d3916ce0628137784c60396b63f83fab7e98e2' WHEN 59 THEN '3d73330e2375aefa8a07f66440adb5e8541bcfe8c8690f2f92466a5b3e151ca4' WHEN 60 THEN '674f8c55f94b53e5472a4bb9267404ef608a86e018fac29badab20db45d4a210' WHEN 61 THEN 'c9d07832b711c011cb884b14d120210fff190387c3a9d992933aa55e7df56b50' WHEN 62 THEN '4a80c68a4cfd761912cd58b3020299a2e382d2f5f70102246ba0eb6be1b79563' WHEN 63 THEN 'bdb290493c2140c57ad34ccb20ab5a321293d26f5bb99c1e8eb19beb1010820e' WHEN 64 THEN '800885f24341e1216d26fcc2f18ab3a4b96144cd78aa0f25d6278f61ec5595d8' WHEN 65 THEN '837a3b019b9c793597ab4f11ce6f2d5202cbf7dc5f460beb23d313f731c42481' WHEN 66 THEN '0cba754aca125d948024d0cd288c26eaf348c7a2182023b8816c68d8ac335ff5' WHEN 67 THEN 'd0c574442ddd8cda674e207e2996c12b963fe46222339fa2b39aa8a439893b7b' WHEN 68 THEN 'bce51836a33a34bf60e6607002c41c34f55b467e9e97dec7d77e3f1d00bc7583' WHEN 81 THEN 'e008221cc217124b16f2668ae2a6aa8e2e0337270e3af1f64ec5b072dad952a0' WHEN 90 THEN '696462ac5c08c60f7bae5b1c76f27b5eb932f82a195e88370de86f107c129f57' WHEN 91 THEN 'bfa84e754afe4dd2e099af529f4bbb5f934e84c06324a17e9341eb16f94d9ba8' WHEN 92 THEN '4986b735b91bed25b91722b377b92f5a04722ea2f0d804198230c242de4137b7' WHEN 93 THEN '4e2db1a6581e8d92bb51ea99fd559ec6c84a5f97b20dd94834805a8e90f97b9a' WHEN 94 THEN 'eb12cae0f2258e648e708aa09a9465e559b9fc9f25edd1b1e9e2507d01eb8bc8' WHEN 95 THEN '58cad92e8c7c3802da9ee701788cbbb7411377421da5e1800fdf7d39cd3ad67d' WHEN 96 THEN 'a2ab77e854a3cfb2e0f1374ef13c1d9d60117e21b624c45fe859c3d03e712925' WHEN 97 THEN 'f248f59860e9a50af5a8eb406019fa0c1e35d07c0c51d2d094b46d4e4f6f7b8b' WHEN 98 THEN '7b2a3c2c3a653c1791e13814ca7671d0e57298a3a7655b5b72987b35dfea121c' WHEN 99 THEN '0e80457d21b78be4fc9bd63a13271b7d329e89b55dc3d7c01f094294b1088513' WHEN 100 THEN 'b15abc3902a860717f705ac90f96347572f0799eb60bbfbcf6c3b7e9212f66a8' WHEN 101 THEN 'ec7912bcf428f0432b592b6e16ef94352c21211b8e3e92f09f100cae312a009f' WHEN 102 THEN '65973bc018f0789e902ed8057d0e3737feb6c254f4aeab4a657f3850b5295734' WHEN 103 THEN '781597c89b49db8eb41f4c1d2b0e1e0461021c9a5eb586d02068ab561f1bc433' WHEN 104 THEN 'b5a940dac08680ce70e87302bbf2790894ae9de10f73e8ee6f910cd5fcdfb926' WHEN 105 THEN 'f75128e442cfd6596660dfb9816d1cbbbeece58f24ca5a80d1c6c0df53b08b11' WHEN 106 THEN 'c917a382c051a6a5dbad6fe82266a1732e9940c4cf9db2c5d402787288b70c1b' WHEN 107 THEN 'b28b3306aba3209427e727291d916643eeef1f399c62ee73c6deca12c6d49c0e' WHEN 108 THEN '47527df63f632a413e4021fe559e8484b3fdae7fcd29b58f31f418a06b212203' WHEN 109 THEN '0d63f65cb5e36db90187d732393a47578f228dc71168939358b06e2fdade1949' WHEN 110 THEN 'e6a63d68c50fcae8d24cb288c363fe12669947fd7fb080ac8f25d648af2d0073' WHEN 111 THEN 'f2eba32c5cb87c0cbdbde8696cb5b39b29dd8c0c004919142238dec7076bc6f1' WHEN 112 THEN 'ea11c90b37f3c3453bf268cd1e5747cba7f15b3721bab03c0923c036c29fd19a' WHEN 113 THEN 'a1cf5d3c141e50b5233a1a73395177dfca9eb348cd8b7e2e101c81abb6e90fe9' WHEN 114 THEN '7e5dafbf5e912ad5bbb4e0851dcf5cae55f4b7741bfb972536710e58b99274e9' WHEN 115 THEN 'afe72b4be422324bdd05ee16d5c1b6ac6b5d5a566ff366842ab1a4b9a2678e22' WHEN 116 THEN 'e51115d52ab3e493ee1a39b0e5c58d5ce0f7343430da0535bc801233ad4af165' WHEN 117 THEN 'f33b1bfcbae83da97e07450e0aa41d1464bab6f2e72fc183246cd2c9e0bea1c5' WHEN 118 THEN '9737df5313691ad368bc98a84d077981d0a14d677af3dd0d48ffef4e3163681f' WHEN 119 THEN 'b5c1b3654e7d98ab35b60363d81c480b65e467bfb45320780f78a9dc138880fd' WHEN 120 THEN 'c70a769b40da1d349fb39b2d61b4b95c9c0cc1325889271180054f95017904e1' WHEN 121 THEN 'e249488b2d610f2ead3986576fd88f704fc0890cd05e59cb96f270ce93ffc76a' WHEN 122 THEN '19545f084ab31d570923d98c2794d56b9749b82a682eca6119484e5d72e62eda' WHEN 123 THEN 'f950fb8efc4eb8b5e763ada1ced47468598c9a754a366e4c672fcaa486f3b7a4' WHEN 124 THEN 'e10eb3fc58e885538daa732b1c62bce97a38776fa9c67daefc2270e0bbb2a4c9' WHEN 125 THEN 'c33044a558ef8373c474947718a13d4086e5ff506b8b3afa3613ad7b17be613b' WHEN 126 THEN 'b94967b4049373a8d1b38e67ba17b674755b9d031e0bd1ad2442f5b8959c0f6e' WHEN 127 THEN '3cb0d3741e9f524c6db23622358716d1fb9df685a453ea6d6fd0444b58bf7687' WHEN 128 THEN '4b3393bbdddeb82535e8ebb578cf034991d6d0c02657653f6f79ef2ce0c2e114' WHEN 129 THEN '9af90928d745006ae748f1b0cd8956b3b35f97fd07cb9f51f4dee895ffb61ab4' WHEN 130 THEN '60b780417e7ca5d8a04900be2b8d78d89c346d446b574c1ffcfd7e93fb1ffbfd' WHEN 131 THEN '2dc1db1283e78ba89e2066116f7e516c5f9d8646e990bf0b89525c6d9c5a896e' WHEN 132 THEN '7674f3d438de622849ae82d916cf608a7e012c01dc2f3afcb00a7ed1992c9b60' WHEN 133 THEN 'dc16d95b29310ce07e758ba2280a6094794af4b12364c1961898d5f38589d34c' WHEN 134 THEN '6b7e8f0fd664c3bc381fc9588e490f82ee6fe1057aa503a09881390d17e770a4' WHEN 135 THEN '918e862f3c3ba58fe40f7d25a32490c7eae6c213a8ecc5f2aef6319e0f7c9577' WHEN 136 THEN '696521a170c57bcba7d37b5a413e8ff88075a2a39d8d2346425d48bc88f80425' WHEN 137 THEN 'c69a8ef3d0ab9875446a178738f2daf6b621b3934de4a108a51d59a7168ee9cb' WHEN 138 THEN 'a6cfa60f1725cc7b6403691aaed081c82dcb42e60befae5737908fd62a1cdc4e' WHEN 139 THEN 'd0b1a40d44981440f2cdfe9906fdd4d94653b72d92d017fe41a46ea9eb8a9407' WHEN 140 THEN 'b33373651da6b55115d16d5236dcf679604c4d2885208d468274bb9e85e05cef' WHEN 141 THEN '80227fe59a75bd5c77c92d3a4995d8dc978d2d4429a8b3e25748ebb38c9e7ac9' WHEN 142 THEN '5474c59c75b62234018b0b7491532165d04e8ff1e6ca315bc5462e526332dac9' WHEN 143 THEN '19ae4f467aa3113f08eb2aff74f0cff1405afb14137127ec7e4b10c4d1ac4094' END WHERE content_sha256 IS NULL AND id IN (1, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 81, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 122, 123, 124, 125, 126, 127, 128, 129, 130, 131, 132, 133, 134, 135, 136, 137, 138, 139, 140, 141, 142, 143);
--> statement-breakpoint
-- Stopgap until Publish: the code running now only hides archived rows. Expect 3.
UPDATE job_media SET archived_at = unixepoch(), updated_at = unixepoch() WHERE id IN (126, 137, 45) AND archived_at IS NULL;
--> statement-breakpoint
INSERT INTO activity_log (job_id, entity_type, entity_id, action, detail, actor_name, actor_role) SELECT NULL, 'storage', NULL, 'storage_made_private', 'File storage set to private at about 4:58pm on 9 Nov. Before that, anyone holding a file address could open it. Files now open only through a short signed link from Terra Ops. Earlier signed links still work until they expire.', 'Runable, for Damien', 'system' WHERE NOT EXISTS (SELECT 1 FROM activity_log WHERE action = 'storage_made_private' AND entity_type = 'storage' AND coalesce(entity_id, 0) = coalesce(NULL, 0));
--> statement-breakpoint
INSERT INTO activity_log (job_id, entity_type, entity_id, action, detail, actor_name, actor_role) SELECT 4242, 'job_media', 142, 'file_restricted', 'Returned quote Q188016 (from the email of 9 Nov) marked restricted, office only. It sat in Plans from 3:43pm to 4:28pm on 9 Nov, and the installer on task 77 could list it from about 4:10pm. There is no view log, so a view is not confirmed either way.', 'Runable, for Damien', 'system' WHERE NOT EXISTS (SELECT 1 FROM activity_log WHERE action = 'file_restricted' AND entity_type = 'job_media' AND coalesce(entity_id, 0) = coalesce(142, 0));
--> statement-breakpoint
INSERT INTO activity_log (job_id, entity_type, entity_id, action, detail, actor_name, actor_role) SELECT 4229, 'job_media', 126, 'file_restricted', 'Returned quote Q188003 marked restricted, office only, and archived until Publish. It was in Plans. No crew task has been on this job.', 'Runable, for Damien', 'system' WHERE NOT EXISTS (SELECT 1 FROM activity_log WHERE action = 'file_restricted' AND entity_type = 'job_media' AND coalesce(entity_id, 0) = coalesce(126, 0));
--> statement-breakpoint
INSERT INTO activity_log (job_id, entity_type, entity_id, action, detail, actor_name, actor_role) SELECT 4298, 'job_media', 137, 'file_restricted', 'Returned quote Q188071 marked restricted, office only, and archived until Publish. It was in Plans. No crew task has been on this job.', 'Runable, for Damien', 'system' WHERE NOT EXISTS (SELECT 1 FROM activity_log WHERE action = 'file_restricted' AND entity_type = 'job_media' AND coalesce(entity_id, 0) = coalesce(137, 0));
--> statement-breakpoint
INSERT INTO activity_log (job_id, entity_type, entity_id, action, detail, actor_name, actor_role) SELECT 4235, 'job_media', 45, 'file_restricted', 'Photo of a payment confirmation marked restricted, office only, and archived until Publish. No crew installer has been assigned on this job.', 'Runable, for Damien', 'system' WHERE NOT EXISTS (SELECT 1 FROM activity_log WHERE action = 'file_restricted' AND entity_type = 'job_media' AND coalesce(entity_id, 0) = coalesce(45, 0));
--> statement-breakpoint
INSERT INTO activity_log (job_id, entity_type, entity_id, action, detail, actor_name, actor_role) SELECT NULL, 'job_media', NULL, 'files_privacy_backfill', 'Job files sorted for privacy from the 9 Nov audit. Crew photos and office files stay crew visible. Emailed files wait for the office. Returned quotes and a payment photo are restricted.', 'Runable, for Damien', 'system' WHERE NOT EXISTS (SELECT 1 FROM activity_log WHERE action = 'files_privacy_backfill' AND entity_type = 'job_media' AND coalesce(entity_id, 0) = coalesce(NULL, 0));
