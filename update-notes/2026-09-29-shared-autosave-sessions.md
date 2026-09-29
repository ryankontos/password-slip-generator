# Shared autosave sessions

- Studio work now autosaves to the local service as a revisioned session, in addition to the existing browser fallback.
- Recent sessions can be opened directly from the header in any browser or tab on the same Mac.
- Tabs pick up newer saved revisions automatically when it is safe to do so.
- Conflicting edits are preserved as a separate recovered session instead of overwriting work.
- Session storage uses atomic writes and keeps a backup copy to make recovery from an interrupted or damaged write more reliable.
- Opening a workspace, template, blank session, or full reset waits for the current autosave before switching sessions.
