# password-slip-generator

Created by Ryan Kontos, 2026. Licensed under the 0BSD licence.

Download the SharePoint Excel file to `~/Downloads`, then open `run_password_slips.command`.

The `.command` launcher lives at the project root, source code is in `src`, and editable JSON files are in `settings`.

Press Enter to use the newest Excel file in Downloads, then choose the sheet and column letters. Add `*` after a column letter, such as `B*`, to print that column with `password_font`; add `-`, such as `C-`, when that column can be truncated instead of shrunk. The script remembers your last column combo, saved row filters, and shows a quick preview.

Row filters are optional. Choose `0` for no row rule, a saved rule number, `n` to create a rule, or `c` to manually enter spreadsheet row numbers such as `2,5,9` or a range like `10-15`. When creating a rule, the script lists existing values from that column so you can choose one quickly. The script can also add extra blank slips, and pressing Enter reuses the last blank-slip count.

At the finish step, press Enter or type `o` to open a temporary PDF in Preview, type `e` to export a saved PDF, or type `p` to export and print.

Page layout lives in `settings/layout_settings.json`. The script creates this file with defaults if it does not exist; edit that file to change slip height, slip padding, margins, colours, spacing, and font sizes.

Field widths are balanced per slip: they stay mostly even, but widen for longer text when needed.

The PDF footer can show the sheet name, generated date/time, and page numbers. These footer options are in `settings/layout_settings.json` and are on by default.

General app settings live in `settings/settings.json`. The script creates this file automatically; it stores the input folder, output folder, allowed workbook extensions, last selected column numbers, row filters, and extra blank-slip count.

0BSD is a very permissive open-source licence. See `LICENSE` for the full text.
