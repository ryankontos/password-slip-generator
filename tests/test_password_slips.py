import json
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

from src.password_slips import (
    Settings,
    apply_env_settings,
    automatic_blank_slips,
    choose_action,
    choose_columns,
    configured_email_address,
    generated_records,
    make_pdf,
    open_email_draft,
    row_numbers_from_text,
    save_app_settings,
    summary_page_count,
)
from src.migrate_settings_to_env import migrate_settings_to_env


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

    def test_summary_is_counted_after_slip_pages(self):
        settings = Settings(columns=["Name"], include_summary_page=True)
        data_records = [["user001"], ["user002"]]

        with tempfile.TemporaryDirectory() as temporary_directory:
            output = Path(temporary_directory) / "password-slips.pdf"
            slip_count, page_count = make_pdf(settings, output, data_records)

        self.assertEqual(slip_count, 7)
        self.assertEqual(page_count, 2)
        self.assertEqual(summary_page_count(settings, len(data_records)), 1)

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

    def test_email_delivery_choice_is_remembered(self):
        settings = Settings(email_address="staff@example.com")

        with patch("builtins.input", return_value="2"):
            action = choose_action(settings)

        self.assertEqual(action, "email")
        self.assertTrue(settings.email_pdf)

        with patch("builtins.input", return_value="1"):
            action = choose_action(settings)

        self.assertEqual(action, "export")
        self.assertFalse(settings.email_pdf)

    def test_email_choice_requires_an_env_address(self):
        settings = Settings()

        with patch("builtins.input", return_value="2"):
            action = choose_action(settings)

        self.assertEqual(action, "export")
        self.assertFalse(settings.email_pdf)

    def test_email_address_comes_from_environment(self):
        with patch.dict("os.environ", {"PASSWORD_SLIPS_EMAIL_ADDRESS": "staff@example.com"}, clear=True):
            self.assertEqual(configured_email_address(), "staff@example.com")

    def test_env_overrides_application_and_layout_settings(self):
        settings = Settings()
        values = {
            "PASSWORD_SLIPS_INPUT_FOLDER": "/tmp/input",
            "PASSWORD_SLIPS_COLUMN_NUMBERS": "[2, 4]",
            "PASSWORD_SLIPS_INCLUDE_SUMMARY_PAGE": "true",
            "PASSWORD_SLIPS_HEADER_HEIGHT_MM": "24.5",
            "PASSWORD_SLIPS_HEADER_COLOR": "#123456",
            "PASSWORD_SLIPS_SHOW_FOOTER": "false",
        }

        with patch.dict("os.environ", values, clear=True):
            apply_env_settings(settings)

        self.assertEqual(settings.input_folder, "/tmp/input")
        self.assertEqual(settings.column_numbers, [2, 4])
        self.assertTrue(settings.include_summary_page)
        self.assertEqual(settings.header_height_mm, 24.5)
        self.assertEqual(settings.header_color, "#123456")
        self.assertFalse(settings.show_footer)

    def test_email_draft_uses_pdf_name_as_subject(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            pdf = Path(temporary_directory) / "staff slips.pdf"
            pdf.write_bytes(b"%PDF-test")
            completed = unittest.mock.Mock(stdout="outlook\n")

            with patch("src.password_slips.subprocess.run", return_value=completed) as run:
                opened, attached = open_email_draft(pdf, "staff@example.com")

        self.assertEqual((opened, attached), (True, True))
        command = run.call_args.args[0]
        self.assertEqual(command[0], "osascript")
        self.assertIn("Microsoft Outlook", command[2])
        self.assertIn("subjectLine", command[2])
        self.assertEqual(command[5], "staff slips.pdf")

    def test_saved_settings_use_column_letters_and_row_filter_letters(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            settings_path = Path(temporary_directory) / "settings.json"
            settings = Settings(
                column_numbers=[1, 3],
                password_column_numbers=[3],
                row_filters=[{"mode": "include", "column_number": 2, "value": "BFS"}],
            )

            with patch("src.password_slips.SETTINGS_FILE", settings_path):
                save_app_settings(settings)

            saved = json.loads(settings_path.read_text(encoding="utf-8"))

        self.assertEqual(saved["column_letters"], ["A", "C"])
        self.assertEqual(saved["password_column_letters"], ["C"])
        self.assertEqual(saved["row_filters"][0]["column_letter"], "B")
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
                    "PASSWORD_SLIPS_CUSTOM_SETTING=keep-me",
                    "PASSWORD_SLIPS_INCLUDE_SUMMARY_PAGE=true",
                ]) + "\n",
                encoding="utf-8",
            )

            migrate_settings_to_env(settings_path, layout_path, env_path)
            migrated = env_path.read_text(encoding="utf-8")

        self.assertIn('PASSWORD_SLIPS_COLUMN_LETTERS=["A","C"]', migrated)
        self.assertIn('PASSWORD_SLIPS_PASSWORD_COLUMN_LETTERS=["C"]', migrated)
        self.assertIn('"column_letter":"B"', migrated)
        self.assertIn("PASSWORD_SLIPS_EMAIL_ADDRESS=keep@example.com", migrated)
        self.assertIn("PASSWORD_SLIPS_CUSTOM_SETTING=keep-me", migrated)
        self.assertIn("PASSWORD_SLIPS_INCLUDE_SUMMARY_PAGE=true", migrated)
        self.assertIn("PASSWORD_SLIPS_HEADER_HEIGHT_MM=24.0", migrated)


if __name__ == "__main__":
    unittest.main()
