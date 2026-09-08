/**
 * Plain text layout for the prove-it run. No colours and no box drawing characters, because the
 * output is read in a terminal, pasted into a report and committed to the repo, and all three
 * have to look the same.
 */

export interface Column {
  header: string;
  /** Numbers read better pushed to the right. Everything else stays left. */
  align?: "left" | "right";
}

/**
 * Lays out a table padded to the widest cell in each column.
 *
 * Returns one string per line, so a caller can print each line and keep it for the report file.
 * Throws when a row has a different number of cells than there are columns, because a shifted
 * row in a proof document is worse than no table.
 */
export function renderTable(columns: Column[], rows: string[][]): string[] {
  if (columns.length === 0) {
    throw new Error("renderTable needs at least one column.");
  }

  const widths = columns.map((column, index) => {
    let width = column.header.length;
    for (const row of rows) {
      if (row.length !== columns.length) {
        throw new Error(`A table row has ${row.length} cells and the table has ${columns.length}.`);
      }
      width = Math.max(width, (row[index] ?? "").length);
    }
    return width;
  });

  const line = (cells: string[]): string =>
    cells
      .map((cell, index) => {
        const width = widths[index] ?? cell.length;
        return columns[index]?.align === "right" ? cell.padStart(width) : cell.padEnd(width);
      })
      .join("  ")
      .trimEnd();

  return [
    line(columns.map((column) => column.header)),
    widths.map((width) => "-".repeat(width)).join("  "),
    ...rows.map(line),
  ];
}

/** A numbered section header with a rule under it, so the sections are easy to find in the log. */
export function heading(text: string): string[] {
  return ["", text, "=".repeat(text.length)];
}

/** PASS or FAIL, spelled the same way everywhere so a judge can grep for FAIL. */
export function verdict(passed: boolean): string {
  return passed ? "PASS" : "FAIL";
}
