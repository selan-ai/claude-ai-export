## Zip schema

Read out of the CLI binary (zod definitions, ~offset 312298000 in
`~/.local/share/claude/versions/2.1.239`) and then confirmed by running a
fixture through `import-conversations --dry-run`.

    conversations.json   [{ uuid, name, created_at?, updated_at?, project_uuid|null,
                            chat_messages: [{ uuid, parent_message_uuid|null, sender,
                              text, content: [{ type, text? }], created_at,
                              attachments: [{ file_name, extracted_content }],
                              files: [{ file_uuid, file_name? }] }] }]
    projects.json        [{ uuid, name, prompt_template?,
                            docs: [{ filename?, content }],
                            files: [{ file_uuid, file_name? }] }]   (or projects/*.json)
    users.json           [{ uuid }]          -> account_uuid only
    files/<file_uuid>    raw bytes
    manifest.json        optional -- omit it, see below

Fixture result: `conversations=1 messages=2 projects=1 docs=1 files=1`, exit 0,
project landing as `my-project-<uuid>`, chat correctly bound to it.

### Four things that bite

1. **`prompt_template`** is the project-instructions key. It becomes
   `projects/<slug>/project-instructions.md`, i.e. the Space's Instructions.
2. **`files/<file_uuid>` with no extension.** The basename must match
   `^[a-zA-Z0-9_-]+$`; anything with a dot is dropped without a message. The
   importer re-attaches the real name itself (`files/<uuid>-<file_name>`).
3. **Omit `manifest.json`.** Supplied and disagreeing by even one message, the
   CLI exits non-zero with `IMPORT_MANIFEST_MISMATCH` and Desktop fails the
   whole import — tested. Absent, the importer derives the manifest from the
   data, so it can never mismatch.
4. **Project names must slugify.** If `${slug(name)}-${uuid}` falls outside
   `^[a-zA-Z0-9_-]+$` or exceeds 200 chars, the project is dropped silently.
   The exporter logs these to `skipped.json`.

Ignored entirely: `is_starred`, `model`, `index`, `summary`, `settings`.
