# password-slip-generator

Created by Ryan Kontos, 2026. Licensed under the 0BSD licence.

Download the SharePoint Excel file to your Downloads folder, then use the launcher for your computer:

- macOS: open `run_password_slips.command`. It uses the Python included with macOS and creates a local `.venv` automatically.
- Windows: double-click `run_password_slips.bat`. Install Python 3.9 or newer from [python.org](https://www.python.org/downloads/windows/) first, selecting “Add Python to PATH”; the launcher creates the local `.venv` and installs the required packages.

On either platform, the first run may take a moment while the Excel and PDF packages are installed.

Press Enter to use the newest Excel file in Downloads, then choose the sheet and column letters. Add `*` after a letter, such as `B*`, to print that column with `password_font`; add `-`, such as `C-`, when that column may truncate instead of shrinking. The selected header names and options are previewed in print order, with options shown in brackets, so they can be confirmed or reselected.

Hidden spreadsheet rows are always excluded. Row selection is optional. Choose all rows, a saved quick rule set, create a new rule set, or enter specific spreadsheet rows such as `2,5,9` or `10-15`. When creating a rule, the script lists existing values from that column so you can choose one quickly.

Row selection is optional. Choose all rows, a saved quick rule set, create a new rule set, or enter specific spreadsheet rows such as `2,5,9` or `10-15`. A rule set can contain several rules, applied together with AND, and can be named for one-step reuse on later runs.

After row selection, the script reports the blanks needed to finish the last slip page and asks only for any additional blank slips. The PDF is then written automatically to Downloads. Set `PASSWORD_SLIPS_OUTPUT_FOLDER` in `.env` to use another folder; there is no output-folder prompt.

A compact summary is always included as the first page(s) of the PDF and contains the selected workbook rows, excluding automatic and extra blank slips. Extra titled blank columns can be added for handwritten notes with one JSON array:

```dotenv
PASSWORD_SLIPS_EXTRA_SUMMARY_COLUMNS=["Notes","Follow-up"]
```

If `PASSWORD_SLIPS_EMAIL_ADDRESS` is set, the script asks after exporting whether to open a draft in the default mail app. The draft is addressed to that email and has a subject like `Generated Password Slips: Staff — 2026-08-07 14:30`. The PDF is not attached automatically, so the generated path remains visible for manual attachment on macOS and Windows.

Copy `.env.example` to `.env` for the complete configuration template. Non-blank `PASSWORD_SLIPS_*` values override generated JSON settings. Interactive choices are remembered in `settings/settings.json`; layout defaults are in `settings/layout_settings.json` and can also be overridden by `.env`. Column selections and rule references are stored as letters, such as `A` and `C`, rather than numbers.

For an older JSON configuration, open `migrate_settings_to_env.command` on macOS or `migrate_settings_to_env.bat` on Windows. It merges the old app and layout settings into `.env`, converts numeric column references to letters, and preserves `.env` fields that do not exist in the old format. Run it with `--dry-run` from Terminal or Command Prompt to preview the migration.

See `LICENSE` for the full licence text.
