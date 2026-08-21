import json
import os
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

from src.migrate_settings_to_env import migrate_settings_to_env
from src.password_slips import (
    Settings,
    apply_env_settings,
    automatic_blank_slips,
    choose_columns,
    clean_path,
    configured_email_address,
    configured_extra_summary_columns,
    email_subject,
    generated_records,
    load_env_file,
    make_pdf,
    open_email_draft,
    output_path,
    row_matches_filters,
    row_numbers_from_text,
    save_app_settings,
    saved_row_filter_sets,
    summary_page_count,
    summary_table,
)


class PasswordSlipGenerationTests(unittest.TestCase):
    def test_automatic_blanks_finish_a_partial_page(self):
        self.assertEqual(automatic_blank_slips(0, 10), 0)
        self.assertEqual(automatic_blank_slips(10, 10), 0)
        self.assertEqual(automatic_blank_slips(12, 10), 8)
        self.assertEqual(automatic_blank_slips(19, 10), 1)

    def test_generated_records_put_extra_blanks_after_automatic_blanks(self):
        settings = Settings(columns=["Name", "Password"], blank_slips=2)
        data_records = [["user001", "pass001"], ["user002", "pass002"]]

        records = generated_records(settings, data_records)

        self.assertEqual(len(records), 9)
        self.assertEqual(records[:2], data_records)
        self.assertTrue(all(not any(row) for row in records[2:]))

    def test_summary_is_always_counted_before_slip_pages(self):
        settings = Settings(columns=["Name"])
        data_records = [["user001"], ["user002"]]

        with tempfile.TemporaryDirectory() as temporary_directory:
            output = Path(temporary_directory) / "password-slips.pdf"
            slip_count, page_count = make_pdf(settings, output, data_records)

        self.assertEqual(slip_count, 7)
        self.assertEqual(page_count, 2)
        self.assertEqual(summary_page_count(settings, len(data_records)), 1)

    def test_extra_summary_column_array_adds_titled_blank_columns(self):
        environment = {
            "PASSWORD_SLIPS_EXTRA_SUMMARY_COLUMNS": '["Notes","Follow-up","Notes"]'
        }
        with patch.dict("os.environ", environment, clear=True):
            columns = configured_extra_summary_columns()

        settings = Settings(columns=["Name"], extra_summary_columns=columns)
        table_columns, table_rows = summary_table(settings, [["Alex"], ["Sam"]])

        self.assertEqual(table_columns, ["Name", "Notes", "Follow-up"])
        self.assertEqual(table_rows, [["Alex", "", ""], ["Sam", "", ""]])

    def test_env_file_loader_supports_json_arrays_without_python_dotenv(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            env_path = Path(temporary_directory) / ".env"
            env_path.write_text(
                'PASSWORD_SLIPS_EXTRA_SUMMARY_COLUMNS=["Notes","Follow-up"]\n'
                'PASSWORD_SLIPS_HEADER_COLOR=#123456\n',
                encoding="utf-8",
            )
            with patch.dict("os.environ", {}, clear=True):
                load_env_file(env_path)
                self.assertEqual(
                    configured_extra_summary_columns(),
                    ["Notes", "Follow-up"],
                )
                self.assertEqual(os.environ["PASSWORD_SLIPS_HEADER_COLOR"], "#123456")

    def test_manual_row_ranges_remain_supported(self):
        self.assertEqual(row_numbers_from_text("2, 5, 9-11"), [2, 5, 9, 10, 11])

    def test_column_names_can_be_reselected_after_preview(self):
        settings = Settings()

        with patch("builtins.input", side_effect=["B,A", "n", "A", "y"]):
            columns, numbers, password_numbers, truncate_numbers = choose_columns(
                ["First name", "Password"],
                settings,
            )

        self.assertEqual(columns, ["First name"])
        self.assertEqual(numbers, [1])
        self.assertEqual(password_numbers, [])
        self.assertEqual(truncate_numbers, [])

    def test_multiple_row_rules_are_chained_with_and(self):
        rules = [
            {"mode": "include", "column_number": 1, "value": "BFS"},
            {"mode": "exclude", "column_number": 2, "value": "Inactive"},
        ]

        self.assertTrue(row_matches_filters(("BFS", "Active"), rules))
        self.assertFalse(row_matches_filters(("BFS", "Inactive"), rules))
        self.assertFalse(row_matches_filters(("Other", "Active"), rules))

    def test_legacy_rules_become_named_quick_sets(self):
        sets = saved_row_filter_sets({
            "row_filters": [
                {"mode": "include", "column_number": 2, "value": "BFS"},
                {"mode": "exclude", "column_letter": "C", "value": "Inactive"},
            ]
        })

        self.assertEqual([item["name"] for item in sets], ["Saved rule 1", "Saved rule 2"])
        self.assertEqual(sets[0]["rules"][0]["column_number"], 2)
        self.assertEqual(sets[1]["rules"][0]["column_number"], 3)

    def test_email_address_comes_from_environment(self):
        with patch.dict("os.environ", {"PASSWORD_SLIPS_EMAIL_ADDRESS": "staff@example.com"}, clear=True):
            self.assertEqual(configured_email_address(), "staff@example.com")

    def test_env_overrides_application_and_layout_settings(self):
        settings = Settings()
        values = {
            "PASSWORD_SLIPS_INPUT_FOLDER": "/tmp/input",
            "PASSWORD_SLIPS_OUTPUT_FOLDER": "/tmp/output",
            "PASSWORD_SLIPS_COLUMN_LETTERS": '["B","D"]',
            "PASSWORD_SLIPS_HEADER_HEIGHT_MM": "24.5",
            "PASSWORD_SLIPS_HEADER_COLOR": "#123456",
            "PASSWORD_SLIPS_SHOW_FOOTER": "false",
        }

        with patch.dict("os.environ", values, clear=True):
            apply_env_settings(settings)

        self.assertEqual(settings.input_folder, "/tmp/input")
        self.assertEqual(settings.output_folder, "/tmp/output")
        self.assertEqual(settings.column_numbers, [2, 4])
        self.assertEqual(settings.header_height_mm, 24.5)
        self.assertEqual(settings.header_color, "#123456")
        self.assertFalse(settings.show_footer)

    def test_output_defaults_to_downloads_without_a_prompt(self):
        settings = Settings(workbook="/tmp/source.xlsx")
        with patch.dict("os.environ", {}, clear=True):
            apply_env_settings(settings)

        self.assertEqual(
            output_path(settings),
            Path.home() / "Downloads" / "source - password slips.pdf",
        )

    def test_email_draft_uses_default_mail_app_without_an_attachment(self):
        with patch("src.password_slips.subprocess.run") as run:
            opened = open_email_draft(
                "staff@example.com",
                "Generated Password Slips: Staff — 2026-08-07 14:30",
            )

        self.assertTrue(opened)
        command = run.call_args.args[0]
        self.assertEqual(command[0], "open")
        self.assertTrue(command[1].startswith("mailto:staff@example.com?subject="))
        self.assertNotIn("attachment", command[1].lower())

    def test_email_draft_uses_windows_default_mail_app(self):
        with patch("src.password_slips.sys.platform", "win32"), patch(
            "src.password_slips.os.startfile", create=True
        ) as startfile:
            opened = open_email_draft("staff@example.com", "Password slips")

        self.assertTrue(opened)
        self.assertTrue(startfile.call_args.args[0].startswith("mailto:staff@example.com?subject="))

    def test_windows_paths_keep_their_backslashes(self):
        with patch("src.password_slips.sys.platform", "win32"):
            path = clean_path(r'"C:\Users\Ryan\Downloads\staff slips.xlsx"')

        self.assertEqual(path, r"C:\Users\Ryan\Downloads\staff slips.xlsx")

    def test_email_subject_has_sheet_and_current_date_time(self):
        subject = email_subject(
            Settings(sheet="Staff"),
            datetime(2026, 8, 7, 14, 30),
        )
        self.assertEqual(
            subject,
            "Generated Password Slips: Staff — 2026-08-07 14:30",
        )

    def test_saved_settings_use_column_letters_and_chained_rule_sets(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            settings_path = Path(temporary_directory) / "settings.json"
            settings = Settings(
                column_numbers=[1, 3],
                password_column_numbers=[3],
                saved_row_filter_sets=[{
                    "name": "BFS active",
                    "rules": [
                        {"mode": "include", "column_number": 2, "value": "BFS"},
                        {"mode": "exclude", "column_number": 4, "value": "Inactive"},
                    ],
                }],
            )

            with patch("src.password_slips.SETTINGS_FILE", settings_path):
                save_app_settings(settings)

            saved = json.loads(settings_path.read_text(encoding="utf-8"))

        self.assertEqual(saved["column_letters"], ["A", "C"])
        self.assertEqual(saved["password_column_letters"], ["C"])
        self.assertIn("email_draft", saved)
        self.assertEqual(saved["saved_row_filter_sets"][0]["name"], "BFS active")
        self.assertEqual(
            [rule["column_letter"] for rule in saved["saved_row_filter_sets"][0]["rules"]],
            ["B", "D"],
        )
        self.assertNotIn("column_numbers", saved)

    def test_migration_converts_columns_and_preserves_extra_env_fields(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            directory = Path(temporary_directory)
            settings_path = directory / "settings.json"
            layout_path = directory / "layout_settings.json"
            env_path = directory / ".env"
            settings_path.write_text(
                json.dumps({
                    "column_numbers": [1, 3],
                    "password_column_numbers": [3],
                    "row_filters": [
                        {"mode": "include", "column_number": 2, "value": "BFS"}
                    ],
                    "blank_slips": 2,
                }),
                encoding="utf-8",
            )
            layout_path.write_text(json.dumps({"header_height_mm": 24.0}), encoding="utf-8")
            env_path.write_text(
                "\n".join([
                    "PASSWORD_SLIPS_EMAIL_ADDRESS=keep@example.com",
                    "PASSWORD_SLIPS_EXTRA_SUMMARY_COLUMNS=[\"Notes\"]",
                    "PASSWORD_SLIPS_CUSTOM_SETTING=keep-me",
                ]) + "\n",
                encoding="utf-8",
            )

            migrate_settings_to_env(settings_path, layout_path, env_path)
            migrated = env_path.read_text(encoding="utf-8")

        self.assertIn('PASSWORD_SLIPS_COLUMN_LETTERS=["A","C"]', migrated)
        self.assertIn('PASSWORD_SLIPS_PASSWORD_COLUMN_LETTERS=["C"]', migrated)
        self.assertIn('PASSWORD_SLIPS_SAVED_ROW_FILTER_SETS=', migrated)
        self.assertIn('"column_letter":"B"', migrated)
        self.assertIn("PASSWORD_SLIPS_EMAIL_ADDRESS=keep@example.com", migrated)
        self.assertIn('PASSWORD_SLIPS_EXTRA_SUMMARY_COLUMNS=["Notes"]', migrated)
        self.assertIn("PASSWORD_SLIPS_CUSTOM_SETTING=keep-me", migrated)
        self.assertIn("PASSWORD_SLIPS_HEADER_HEIGHT_MM=24.0", migrated)


if __name__ == "__main__":
    unittest.main()
