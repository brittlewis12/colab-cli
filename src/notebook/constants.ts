/**
 * Shared constants for the notebook conversion pipeline.
 */

/**
 * Cell metadata keys that are internal/default and should NOT be serialized
 * in the percent-format cell marker line. These are either jupytext-internal
 * or standard notebook metadata that doesn't need to appear in the .py file.
 *
 * Used by:
 * - serialize.ts: filter these out when writing cell markers
 * - merge.ts: preserve these from remote (they're internal state)
 */
export const FILTERED_METADATA_KEYS = new Set([
  "collapsed",
  "scrolled",
  "trusted",
  "ExecuteTime",
  "execution",
  // jupytext internals
  "lines_to_next_cell",
  "lines_to_end_of_cell_marker",
  "cell_marker",
  // colab-cli internal (added at parse time for --cell title addressing)
  "title",
]);
