import { describe, expect, it } from "vitest";

import { isIdempotentReapplyError } from "./applyMigrations";

describe("isIdempotentReapplyError", () => {
  it("tolerates GreptimeDB errno 1060 (column already exists on ADD COLUMN re-run)", () => {
    // Shape verified against GreptimeDB v1.1.1 over the MySQL wire: re-running
    // `ALTER TABLE ... ADD COLUMN` on an existing column yields errno 1060.
    const error = Object.assign(
      new Error(
        "(TableColumnExists): Column type already exists in table observations",
      ),
      { errno: 1060, code: "ER_DUP_FIELDNAME", sqlState: "42S21" },
    );
    expect(isIdempotentReapplyError(error)).toBe(true);
  });

  it("does not tolerate other mysql errors (syntax, connection, unknown table)", () => {
    expect(
      isIdempotentReapplyError(
        Object.assign(new Error("syntax"), { errno: 1064 }),
      ),
    ).toBe(false);
    expect(
      isIdempotentReapplyError(
        Object.assign(new Error("no table"), { errno: 1146 }),
      ),
    ).toBe(false);
    expect(
      isIdempotentReapplyError(
        Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" }),
      ),
    ).toBe(false);
  });

  it("is null/undefined/non-object safe", () => {
    expect(isIdempotentReapplyError(null)).toBe(false);
    expect(isIdempotentReapplyError(undefined)).toBe(false);
    expect(isIdempotentReapplyError("1060")).toBe(false);
    expect(isIdempotentReapplyError({})).toBe(false);
  });
});
