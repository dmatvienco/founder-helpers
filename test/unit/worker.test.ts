import { describe, expect, it } from "vitest";
import { staleDigestDay } from "../../src/core/worker.js";

// Every date below is built with the LOCAL constructor and compared on the
// local calendar, so the suite means the same thing in any TZ.
describe("staleDigestDay (#37)", () => {
  it("is undefined for a job added earlier the same local day", () => {
    const now = new Date(2026, 8, 18, 23, 59, 59);
    expect(staleDigestDay(new Date(2026, 8, 18, 0, 0, 0).toISOString(), now)).toBeUndefined();
    expect(staleDigestDay(new Date(2026, 8, 18, 6, 0).toISOString(), now)).toBeUndefined();
  });

  it("names the day of a job added late yesterday and retried after midnight", () => {
    const now = new Date(2026, 8, 19, 0, 5);
    expect(staleDigestDay(new Date(2026, 8, 18, 23, 50).toISOString(), now)).toBe("18.09");
  });

  it("zero-pads day and month", () => {
    const now = new Date(2026, 0, 6, 12);
    expect(staleDigestDay(new Date(2026, 0, 5, 12).toISOString(), now)).toBe("05.01");
  });

  it("crosses a year boundary and tells the same date in another year apart", () => {
    expect(staleDigestDay(new Date(2025, 11, 31, 8).toISOString(), new Date(2026, 0, 1, 8))).toBe(
      "31.12",
    );
    expect(staleDigestDay(new Date(2025, 8, 20, 8).toISOString(), new Date(2026, 8, 20, 8))).toBe(
      "20.09",
    );
  });

  it("never treats an unparseable addedAt as stale", () => {
    expect(staleDigestDay("not-a-date", new Date())).toBeUndefined();
  });
});
