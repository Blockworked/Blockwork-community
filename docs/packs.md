# Pack authoring and official packs

[Back to README](../README.md). Run commands from the repository root.

## Adding a pack

1. Make the blocks in a macro, then right-click one in the My Blocks palette
   and pick "Share blocks as a pack...". Blocks they call come along.
2. Sign in on the library site, open Submit a pack and upload the file.
   Keep the same id for later versions so they replace the old blocks.

Each entry in `blocks.block_defs` can include `identifier` (for example,
`ClickGrid`) and `description` for Blockwork's Details screen. These can
also be set in the app's Make/Edit Block dialog. Keep the internal `id`
stable across versions so installed calls continue to match. An uploaded
`identifier` can't contain `:`; the site stores each one as
`<uploader>:<identifier>` (letters and digits of the account name, then the
ID), so `JohnDoe:OpenYouTubeStudio`, and sets the file's `author` to the
account name. The starter packs predate this and keep `Blockworked_ClickGrid`,
which Blockwork shows as `Blockworked:ClickGrid`. Set `description` on each
block to explain its inputs and behavior. Older packs without these fields still load.
Run `python3 scripts/build-block-index.py` after editing starter packs to
refresh their checksums.

A pack's variables are private to it in Blockwork, so use plain names
(`line`, not `Author pack: line`); they can't clash with the user's own.
Starter packs before 1.1.0 carried a `Blockworked <pack>: ` prefix.

Inputs can include an optional `default_value` literal. Blockwork uses it in
the sidebar and for new calls; updating a pack preserves existing call values.
For example, an active-window input can start empty and a monitor input at 1:

```json
[
  {"kind":"Input","id":"window-input","name":"window","value_type":"Any","default_value":{"kind":"Text","value":""}},
  {"kind":"Input","id":"monitor-input","name":"monitor","value_type":"Any","default_value":{"kind":"Number","value":1}}
]
```

`Any` inputs accept `Text` or finite `Number` defaults. `Bool` inputs accept
`{"kind":"Bool","value":true}` or `false` in the same shape. Defaults cannot
contain expressions or custom block calls. Without a default, inputs keep the
legacy zero or empty Boolean slot. Older app versions ignore the new field.

## Official packs

These packs combine multiple built-in blocks into reusable workflows. Their
definitions were checked against Blockwork's instruction and operator palettes.

| Pack | Blocks |
| --- | --- |
| Clipboard tools | Remove duplicate lines, remove blank lines, clean whitespace |
| Text extraction | Text between literal markers, all lines containing text, value for a `key=value` key |
| Window layouts | Center on a monitor, tile two windows side by side, capture geometry, restore geometry |
| Mouse patterns | Click a grid, drag through points, click relative to a window |
| Mouse helpers | Click, double click, right click and drag at a screen position |
| Text helpers | Check for empty text, get the last letter |

Clipboard tools replace clipboard text after processing it. Line-based blocks
accept LF, CRLF and CR, and produce LF. Duplicate lines and text markers match
exactly, including case. Key lookup trims keys and values, uses the first
matching entry and preserves additional `=` signs in its value.

Window patterns match the first window whose title or app contains the text.
Use patterns that identify different windows for tiling. Monitor numbers start
at 1; layouts use the full monitor rectangle, including panels. Window control
depends on the desktop, and window managers may enforce minimum sizes. Save
the geometry reporter's JSON in a variable, then pass it to the restore block;
it records position and size, not maximized or minimized state.

Mouse grids use absolute screen coordinates and visit columns within each row.
Rows and columns are nonnegative whole numbers; spacing may be negative.
Drag paths contain at least two `x,y` pairs separated by semicolons, such as
`100,100; 200,200`. Line-separated paths are also supported. Pauses
are in milliseconds. Window-relative clicks use offsets from the client area's
top-left and focus the window before clicking.

The first four packs are generated with stable IDs (`build-official-packs.py`
copies its pack settings from `text-helpers.json`). Mouse helpers and Text
helpers are edited by hand:

```bash
python3 scripts/build-official-packs.py
python3 scripts/build-block-index.py
```

For behavior tests using Blockwork's actual Rust parser and interpreter, first
build `blockwork-core` in a Blockwork checkout with the current Rust toolchain,
then run:

```bash
npm run test:runtime -- /path/to/Blockwork/target/debug/deps
```

These tests simulate clipboard/window I/O and record mouse events without
controlling the desktop. They cover all 13 official blocks, Unicode and literal
matching, line endings, invalid inputs, monitor offsets and action order.

CI runs them, and `node scripts/sync-capabilities.js --check`, against the
Blockwork commit in `.blockwork-rev`. Move that commit when Blockwork's
runner or capability table changes.

Reviewers: read the whole pack. The review page lists what its blocks can
do, but a pack in this library should not run commands, go online, write
files or read secrets unless that's plainly its purpose.
