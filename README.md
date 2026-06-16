# password-slip-generator

Download the SharePoint Excel file to `~/Downloads`, then open `run_password_slips.command`.

Press Enter to use the newest Excel file in Downloads, then choose the sheet and column numbers. The script remembers your last column number combo and shows a quick preview before export.

It exports an A4 PDF with identical cut lines on every page, and can open the macOS print dialog when you choose print.

Page layout lives in `layout_settings.json` beside the script. The script creates this file with defaults if it does not exist; edit that file to change slip height, margins, colours, spacing, and font sizes.

General app settings live in `settings.json` beside the script. The script creates this file automatically; it stores the input folder, output folder, default action, allowed workbook extensions, and last selected column numbers.
