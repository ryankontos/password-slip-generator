# password-slip-generator

Created by Ryan Kontos, 2026. Licensed under the 0BSD licence.

Download the SharePoint Excel file to `~/Downloads`, then open `run_password_slips.command`.

The `.command` launchers live at the project root, source code is in `src`, editable JSON files are in `settings`, and all application/layout overrides can be set in `.env`.

Press Enter to use the newest Excel file in Downloads, then choose the sheet and column letters. Add `*` after a column letter, such as `B*`, to print that column with `password_font`; add `-`, such as `C-`, when that column can be truncated instead of shrunk. The script previews the selected header names in print order so you can confirm or rechoose them. It remembers your last column combo, saved row filters, and shows a quick data preview.

Row filters are optional. Choose `0` for no row rule, a saved rule number, `n` to create a rule, or `c` to manually enter spreadsheet row numbers such as `2,5,9` or a range like `10-15`. When creating a rule, the script lists existing values from that column so you can choose one quickly.

After the rows are selected, the script tells you how many blank slips will automatically finish the last slip page. You can then enter an extra blank-slip count; extra slips start after that completed page and can add new page(s). Press Enter to reuse the last extra-slip count.

At the finish step, choose whether to save the PDF only or save it and open an email draft. Email delivery uses the address in `.env`; copy `.env.example` to `.env` and set `PASSWORD_SLIPS_EMAIL_ADDRESS`. On macOS the script tries Outlook for Mac, then Apple Mail, to create a draft with the PDF attached. If attachment automation is unavailable, it opens the default mail app and leaves the PDF ready to attach. The subject is the generated PDF filename. The final prompt asks whether to add an optional summary page. It is appended to the same PDF, has a title with the sheet name and generated date/time, and lists the selected workbook rows in a compact table for staff reference. Automatic and extra blank slips are not included in the summary.

Page layout lives in `settings/layout_settings.json`. The script creates this file with defaults if it does not exist; edit that file to change slip height, slip padding, margins, colours, spacing, and font sizes.

Field widths are balanced per slip: they stay mostly even, but widen for longer text when needed.

The PDF footer can show the sheet name, generated date/time, and page numbers. These footer options are in `settings/layout_settings.json` and are on by default.

General app settings live in `settings/settings.json`, and layout defaults live in `settings/layout_settings.json`. Both files are generated automatically for backward compatibility and to remember interactive choices. Copy `.env.example` to `.env` to configure every application and layout setting explicitly; `PASSWORD_SLIPS_*` values override the JSON values. Column selections are stored as letters, such as `["A","C"]`, and row-filter column references are stored as letters too.

If you have an older JSON configuration, open `migrate_settings_to_env.command`. It merges the old app and layout settings into `.env`, converts numeric column references to letters, and preserves existing `.env` fields that were not present in the old JSON format. Use `--dry-run` to preview the migration.

0BSD is a very permissive open-source licence. See `LICENSE` for the full text.
