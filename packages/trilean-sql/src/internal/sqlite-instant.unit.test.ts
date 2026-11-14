import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sqliteInstantColumn, sqliteInstantParameter } from "./sqlite-instant";

describe("the cost the README states for an instant operand under SQLite", () => {
  const expression = sqliteInstantColumn('"c"');
  const readme = readFileSync(
    new URL("../../README.md", import.meta.url),
    "utf8",
  );

  it("is the work the expression does", () => {
    const calls = (
      expression.match(/\b(?:length|substr|instr|strftime|CAST)\(/gu) ?? []
    ).length;
    const globs = (expression.match(/ GLOB /gu) ?? []).length;
    const mentions = (expression.match(/"c"/gu) ?? []).length;
    expect(readme).toContain(
      `One evaluation makes ${String(calls)} scalar function calls`,
    );
    expect(readme).toContain(`and ${String(globs)} \`GLOB\` tests`);
    expect(readme).toContain(`mentions the column ${String(mentions)} times`);
  });
});

describe("the literal reader's ranges", () => {
  it.each([
    ["an offset's minutes", "2020-01-01T00:00:00+02:60"],
    ["an offset's minutes, negative", "2020-01-01T00:00:00-02:60"],
    ["an offset's hours", "2020-01-01T00:00:00+24:00"],
    ["minutes", "2020-01-01T00:60:00Z"],
    ["seconds", "2020-01-01T00:00:60Z"],
    ["hours", "2020-01-01T24:00:00Z"],
    ["the month", "2020-13-01T00:00:00Z"],
    ["the day", "2020-01-32T00:00:00Z"],
  ])("refuses %s out of range", (_label, text) => {
    expect(sqliteInstantParameter(text)).toBeNull();
  });

  it.each([
    "2020-01-01T00:00:00+23:59",
    "2020-01-01T00:00:00-00:59",
    "2020-01-01T23:59:59Z",
    "2020-12-31T00:00:00Z",
  ])("reads %s at the top of its range", (text) => {
    expect(sqliteInstantParameter(text)).toBe(Date.parse(text));
  });
});
