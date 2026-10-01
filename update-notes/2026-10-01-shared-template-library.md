# Keep saved setups across browsers

- Templates and named colour palettes are now stored on this Mac and shared across browsers and tabs.
- Existing browser templates and saved palettes migrate automatically. Opening an older session no longer replaces the palette library.
- Saves and deletions are queued during service outages and retried after reconnecting, including after reloading the page.
- Replacing a named template or palette requires confirmation. Concurrent changes preserve both versions; deleting an item changed elsewhere requires review.
- Removed silent limits that discarded older templates, palettes, and Recent sessions.
- Reset clears the shared template and palette library, with an explicit confirmation. Prior work remains in Recent.
- Replaced decorative switches with native, keyboard-accessible checkboxes.
- Protected the valid backup from being overwritten by a corrupt primary store.
- Added browser and server regression checks for migration, reconnects, cross-browser sharing, concurrent saves, reset, and backup recovery.
