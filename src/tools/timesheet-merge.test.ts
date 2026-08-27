import { describe, it, expect } from "vitest";
import {
  activityKey,
  buildExceptionalTimesPayload,
  buildRegularTimesPayload,
  existingCollection,
  indexTimesReport,
  relationId,
  requiresReadBeforeWrite,
  resolveExceptionalTimes,
  resolveRegularTimes,
  toPutRegularTime,
} from "./timesheet-merge.js";
import type { JsonApiResponse } from "../types.js";

/** A stored regular time as the API returns it, nested under `attributes`. */
function storedRegularTime(over: Record<string, unknown> = {}) {
  return {
    id: "900",
    row: 55,
    startDate: "2026-07-01",
    duration: 1,
    workUnitType: { reference: 1 },
    delivery: { data: { id: "77", type: "delivery" } },
    batch: { data: null },
    project: { data: { id: "10", type: "project" } },
    ...over,
  };
}

function report(attributes: Record<string, unknown>, included?: JsonApiResponse["included"]): JsonApiResponse {
  return { data: { id: "42", type: "timesreport", attributes }, ...(included ? { included } : {}) };
}

/** Incoming entry for the same activity as `storedRegularTime()`. */
function incoming(over: Record<string, unknown> = {}) {
  return {
    startDate: "2026-07-01",
    duration: 2,
    workUnitType: { reference: 1 },
    delivery: { id: "77" },
    batch: { data: null },
    project: { id: "10" },
    ...over,
  };
}

describe("relationId", () => {
  it("reads the id from every relation shape Boond uses", () => {
    expect(relationId({ id: "7" })).toBe("7");
    expect(relationId({ data: { id: "7", type: "delivery" } })).toBe("7");
    expect(relationId({ data: null })).toBe("");
    expect(relationId(undefined)).toBe("");
    expect(relationId("7")).toBe("7");
    expect(relationId(7)).toBe("7");
  });
});

describe("activityKey", () => {
  it("matches a PUT-body entry with the stored entry of the same activity", () => {
    expect(activityKey(incoming())).toBe(activityKey(storedRegularTime()));
  });

  it("flattens a JSON:API resource (attributes + relationships)", () => {
    const resource = {
      id: "900",
      type: "regulartime",
      attributes: { workUnitType: { reference: 1 } },
      relationships: {
        delivery: { data: { id: "77", type: "delivery" } },
        project: { data: { id: "10", type: "project" } },
      },
    };
    expect(activityKey(resource)).toBe(activityKey(incoming()));
  });

  it("separates activities differing on any key component", () => {
    const base = activityKey(incoming());
    expect(activityKey(incoming({ workUnitType: { reference: 2 } }))).not.toBe(base);
    expect(activityKey(incoming({ delivery: { id: "78" } }))).not.toBe(base);
    expect(activityKey(incoming({ batch: { id: "5" } }))).not.toBe(base);
    expect(activityKey(incoming({ project: { id: "11" } }))).not.toBe(base);
  });
});

describe("indexTimesReport", () => {
  it("indexes rows and per-day entry ids from attributes", () => {
    const index = indexTimesReport(report({ regularTimes: [storedRegularTime()] }));
    const key = activityKey(incoming());
    expect(index.rowByKey.get(key)).toBe(55);
    expect(index.regularIdByKeyDate.get(`${key}@2026-07-01`)).toBe("900");
  });

  it("also indexes entries served through `included`", () => {
    const index = indexTimesReport(
      report({}, [
        {
          id: "901",
          type: "regulartime",
          attributes: { row: 56, startDate: "2026-07-02", workUnitType: { reference: 1 } },
          relationships: { delivery: { data: { id: "77", type: "delivery" } } },
        },
      ])
    );
    const key = activityKey({ workUnitType: { reference: 1 }, delivery: { id: "77" } });
    expect(index.rowByKey.get(key)).toBe(56);
    expect(index.regularIdByKeyDate.get(`${key}@2026-07-02`)).toBe("901");
  });

  it("tolerates a timesheet with no time entries", () => {
    const index = indexTimesReport(report({}));
    expect(index.rowByKey.size).toBe(0);
    expect(index.regularIdByKeyDate.size).toBe(0);
  });

  it("normalizes an ISO datetime startDate to YYYY-MM-DD", () => {
    const index = indexTimesReport(
      report({ regularTimes: [storedRegularTime({ startDate: "2026-07-01T00:00:00Z" })] })
    );
    expect(index.regularIdByKeyDate.has(`${activityKey(incoming())}@2026-07-01`)).toBe(true);
  });
});

describe("resolveRegularTimes", () => {
  it("reuses the existing row and entry id for the same activity on the same day", () => {
    const index = indexTimesReport(report({ regularTimes: [storedRegularTime()] }));
    const { entries, stats } = resolveRegularTimes([incoming()], index);

    expect(entries[0]).toMatchObject({ row: 55, id: "900", duration: 2 });
    expect(stats).toEqual({ reusedRows: 1, newRows: 0, replaced: 1 });
  });

  it("appends to the existing row without an id when the day is not filled yet", () => {
    const index = indexTimesReport(report({ regularTimes: [storedRegularTime()] }));
    const { entries, stats } = resolveRegularTimes([incoming({ startDate: "2026-07-02" })], index);

    expect(entries[0].row).toBe(55);
    expect(entries[0].id).toBeUndefined();
    expect(stats).toEqual({ reusedRows: 1, newRows: 0, replaced: 0 });
  });

  it("creates a new row only when the activity is absent", () => {
    const index = indexTimesReport(report({ regularTimes: [storedRegularTime()] }));
    const { entries, stats } = resolveRegularTimes([incoming({ workUnitType: { reference: 2 } })], index);

    expect(entries[0].row).toBe(-1);
    expect(entries[0].id).toBeUndefined();
    expect(stats).toEqual({ reusedRows: 0, newRows: 1, replaced: 0 });
  });

  it("gives each distinct new activity its own negative row", () => {
    const index = indexTimesReport(report({}));
    const { entries, stats } = resolveRegularTimes(
      [
        incoming({ workUnitType: { reference: 2 } }),
        incoming({ workUnitType: { reference: 3 } }),
        incoming({ workUnitType: { reference: 2 }, startDate: "2026-07-02" }),
      ],
      index
    );

    expect(entries.map((e) => e.row)).toEqual([-1, -2, -1]);
    expect(stats.newRows).toBe(2);
  });

  it("honours an explicit row >= 1 verbatim", () => {
    const index = indexTimesReport(report({ regularTimes: [storedRegularTime()] }));
    const { entries, stats } = resolveRegularTimes([incoming({ row: 99 })], index);

    expect(entries[0].row).toBe(99);
    expect(entries[0].id).toBeUndefined();
    expect(stats).toEqual({ reusedRows: 0, newRows: 0, replaced: 0 });
  });

  it("overrides a caller-supplied negative row when the activity exists", () => {
    const index = indexTimesReport(report({ regularTimes: [storedRegularTime()] }));
    const { entries } = resolveRegularTimes([incoming({ row: -1 })], index);

    expect(entries[0].row).toBe(55);
  });

  it("keeps a caller-supplied entry id", () => {
    const index = indexTimesReport(report({ regularTimes: [storedRegularTime()] }));
    const { entries, stats } = resolveRegularTimes([incoming({ id: "123" })], index);

    expect(entries[0].id).toBe("123");
    expect(stats.replaced).toBe(0);
  });

  it("does not mutate the caller's entries", () => {
    const index = indexTimesReport(report({ regularTimes: [storedRegularTime()] }));
    const entry = incoming();
    resolveRegularTimes([entry], index);
    expect(entry).not.toHaveProperty("row");
  });
});

describe("resolveExceptionalTimes", () => {
  const stored = {
    id: "500",
    startDate: "2026-07-03",
    endDate: "2026-07-03",
    description: "RTT",
    workUnitType: { reference: 8 },
    delivery: { data: { id: "77", type: "delivery" } },
    project: { data: { id: "10", type: "project" } },
  };
  const sent = {
    startDate: "2026-07-03",
    endDate: "2026-07-03",
    description: "RTT (corrigé)",
    workUnitType: { reference: 8 },
    delivery: { id: "77" },
    project: { id: "10" },
  };

  it("attaches the existing id for the same activity and start date", () => {
    const index = indexTimesReport(report({ exceptionalTimes: [stored] }));
    const { entries, replaced } = resolveExceptionalTimes([sent], index);

    expect(entries[0].id).toBe("500");
    expect(replaced).toBe(1);
  });

  it("leaves a new exceptional time without an id", () => {
    const index = indexTimesReport(report({ exceptionalTimes: [stored] }));
    const { entries, replaced } = resolveExceptionalTimes([{ ...sent, startDate: "2026-07-04" }], index);

    expect(entries[0].id).toBeUndefined();
    expect(replaced).toBe(0);
  });
});

describe("requiresReadBeforeWrite", () => {
  it("is true whenever a time collection is sent, even fully pinned", () => {
    expect(requiresReadBeforeWrite({ regularTimes: [incoming()] })).toBe(true);
    expect(requiresReadBeforeWrite({ regularTimes: [incoming({ row: 55 })] })).toBe(true);
    expect(requiresReadBeforeWrite({ exceptionalTimes: [{ id: "500" }] })).toBe(true);
    expect(requiresReadBeforeWrite({ workplaceTimes: [] })).toBe(true);
  });

  it("is false for an update that touches no time collection", () => {
    expect(requiresReadBeforeWrite({ workUnitRate: 50 })).toBe(false);
    expect(requiresReadBeforeWrite({ informationComments: "hello" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Regression fixture captured from the live API: GET /times-reports/525
// (August 2026, resource 8212). Shapes matter here — `row` is a plain
// top-level integer, relations are `{ id, title, … }` objects (NOT
// `{ data: { id } }`) and plain `null` when absent, and `workUnitType` carries
// `reference` alongside `activityType`/`name`. A subset of the 20 entries,
// keeping every distinct line.
// ---------------------------------------------------------------------------
const DIGITAL_LAB = { id: "25", reference: "DIGITAL LAB" };
const DELIVERY_120 = { id: "120", title: "", startDate: "2026-06-01", endDate: "2026-12-31", calendar: "" };
const MISSION = { reference: 1, activityType: "production", name: "Mission" };

const LIVE_REPORT: JsonApiResponse = {
  data: {
    id: "525",
    type: "timesreport",
    attributes: {
      term: "2026-08",
      state: "waitingForValidation",
      regularTimes: [
        // row 1234 — DIGITAL LAB / Lot 5 français
        {
          id: "9307",
          calendar: "calendar",
          startDate: "2026-08-03",
          duration: 1,
          row: 1234,
          workUnitType: MISSION,
          delivery: DELIVERY_120,
          batch: { id: "3", title: "Lot 5 français" },
          project: DIGITAL_LAB,
        },
        {
          id: "9308",
          calendar: "calendar",
          startDate: "2026-08-04",
          duration: 1,
          row: 1234,
          workUnitType: MISSION,
          delivery: DELIVERY_120,
          batch: { id: "3", title: "Lot 5 français" },
          project: DIGITAL_LAB,
        },
        // row 1235 — absence, no relation at all
        {
          id: "9312",
          calendar: "calendar",
          startDate: "2026-08-14",
          duration: 1,
          row: 1235,
          workUnitType: { reference: 6, activityType: "absence", name: "Exceptionnelle" },
          delivery: null,
          batch: null,
          project: null,
        },
        // row 1236 — DIGITAL LAB / Lot 1 Arabe
        {
          id: "9322",
          calendar: "calendar",
          startDate: "2026-08-24",
          duration: 1,
          row: 1236,
          workUnitType: MISSION,
          delivery: DELIVERY_120,
          batch: { id: "9", title: "Lot 1 Arabe" },
          project: DIGITAL_LAB,
        },
        {
          id: "9387",
          calendar: "calendar",
          startDate: "2026-08-26",
          duration: 1,
          row: 1236,
          workUnitType: MISSION,
          delivery: DELIVERY_120,
          batch: { id: "9", title: "Lot 1 Arabe" },
          project: DIGITAL_LAB,
        },
        // row 1244 — internal training, no relation
        {
          id: "9390",
          calendar: "calendar",
          startDate: "2026-08-27",
          duration: 1,
          row: 1244,
          workUnitType: { reference: 9, activityType: "internal", name: "Formation / Journée de partage" },
          delivery: null,
          batch: null,
          project: null,
        },
      ],
      exceptionalTimes: [],
      workplaceTimes: [],
    },
  },
};

/** DIGITAL LAB / Lot 1 Arabe, as an MCP caller sends it (no `row`). */
function lot1Arabe(over: Record<string, unknown> = {}) {
  return {
    startDate: "2026-08-31",
    duration: 1,
    workUnitType: { reference: 1 },
    delivery: { id: "120" },
    batch: { id: "9" },
    project: { id: "25" },
    ...over,
  };
}

describe("live August payload (GET /times-reports/525)", () => {
  it("extracts every activity line, keyed by activity", () => {
    const index = indexTimesReport(LIVE_REPORT);
    expect([...index.rowByKey.entries()].sort()).toEqual([
      ["1|120|3|25", 1234],
      ["1|120|9|25", 1236],
      ["6|||", 1235],
      ["9|||", 1244],
    ]);
  });

  it("appends a new day to the Lot 1 Arabe line instead of duplicating it", () => {
    const index = indexTimesReport(LIVE_REPORT);
    const { entries, stats } = resolveRegularTimes([lot1Arabe()], index);

    expect(entries[0].row).toBe(1236);
    expect(entries[0].id).toBeUndefined();
    expect(stats).toEqual({ reusedRows: 1, newRows: 0, replaced: 0 });
  });

  it("targets the stored entry when that day is already filled", () => {
    const index = indexTimesReport(LIVE_REPORT);
    const { entries, stats } = resolveRegularTimes([lot1Arabe({ startDate: "2026-08-26", duration: 0.5 })], index);

    expect(entries[0]).toMatchObject({ row: 1236, id: "9387", duration: 0.5 });
    expect(stats.replaced).toBe(1);
  });

  it("keeps Lot 5 français and Lot 1 Arabe on separate lines (batch is part of the key)", () => {
    const index = indexTimesReport(LIVE_REPORT);
    const { entries } = resolveRegularTimes([lot1Arabe(), lot1Arabe({ batch: { id: "3" } })], index);

    expect(entries[0].row).toBe(1236);
    expect(entries[1].row).toBe(1234);
  });

  it("matches a no-relation absence line (null delivery/batch/project)", () => {
    const index = indexTimesReport(LIVE_REPORT);
    const { entries } = resolveRegularTimes(
      [
        {
          startDate: "2026-08-31",
          duration: 1,
          workUnitType: { reference: 6 },
          delivery: { data: null },
          batch: { data: null },
          project: { data: null },
        },
      ],
      index
    );

    expect(entries[0].row).toBe(1235);
  });

  it("creates one fresh line for an activity the timesheet does not have", () => {
    const index = indexTimesReport(LIVE_REPORT);
    const { entries, stats } = resolveRegularTimes([lot1Arabe({ workUnitType: { reference: 3 } })], index);

    expect(entries[0].row).toBe(-1);
    expect(stats).toEqual({ reusedRows: 0, newRows: 1, replaced: 0 });
  });
});

describe("buildRegularTimesPayload (data-loss guard)", () => {
  it("echoes every stored entry alongside the new one", () => {
    const { entries, stats } = buildRegularTimesPayload(LIVE_REPORT, [lot1Arabe()]);

    // 6 stored entries in the fixture + the new 2026-08-31 day.
    expect(entries).toHaveLength(7);
    expect(stats.preserved).toBe(6);
    expect(stats.appended).toBe(1);
    expect(stats.dropped).toBe(0);
    expect(entries.map((e) => e.startDate)).toEqual([
      "2026-08-03",
      "2026-08-04",
      "2026-08-14",
      "2026-08-24",
      "2026-08-26",
      "2026-08-27",
      "2026-08-31",
    ]);
  });

  it("keeps every stored entry's id and row so Boond updates in place", () => {
    const { entries } = buildRegularTimesPayload(LIVE_REPORT, [lot1Arabe()]);
    const stored = entries.filter((e) => e.startDate !== "2026-08-31");

    expect(stored.map((e) => [e.id, e.row])).toEqual([
      ["9307", 1234],
      ["9308", 1234],
      ["9312", 1235],
      ["9322", 1236],
      ["9387", 1236],
      ["9390", 1244],
    ]);
  });

  it("replaces a filled day in place rather than adding a second entry", () => {
    const { entries, stats } = buildRegularTimesPayload(LIVE_REPORT, [
      lot1Arabe({ startDate: "2026-08-26", duration: 0.5 }),
    ]);

    expect(entries).toHaveLength(6);
    expect(stats.appended).toBe(0);
    const day = entries.find((e) => e.startDate === "2026-08-26");
    expect(day).toMatchObject({ id: "9387", row: 1236, duration: 0.5 });
  });

  it("strips the read-only decoration the API adds", () => {
    const entry = toPutRegularTime({
      id: "9322",
      calendar: "calendar",
      startDate: "2026-08-24",
      duration: 1,
      row: 1236,
      workUnitType: { reference: 1, activityType: "production", name: "Mission" },
      delivery: { id: "120", title: "", startDate: "2026-06-01" },
      batch: { id: "9", title: "Lot 1 Arabe" },
      project: { id: "25", reference: "DIGITAL LAB" },
    });

    expect(entry).toEqual({
      id: "9322",
      startDate: "2026-08-24",
      duration: 1,
      row: 1236,
      workUnitType: { reference: 1 },
      delivery: { id: "120" },
      batch: { id: "9" },
      project: { id: "25" },
    });
  });

  it("maps an absent relation to { data: null }", () => {
    const entry = toPutRegularTime({
      id: "9312",
      startDate: "2026-08-14",
      duration: 1,
      row: 1235,
      workUnitType: { reference: 6 },
      delivery: null,
      batch: null,
      project: null,
    });

    expect(entry).toMatchObject({ delivery: { data: null }, batch: { data: null }, project: { data: null } });
  });

  it("counts a stored entry with no addressable row as dropped instead of duplicating it", () => {
    const report: JsonApiResponse = {
      data: {
        id: "525",
        type: "timesreport",
        attributes: {
          regularTimes: [{ id: "1", startDate: "2026-08-03", duration: 1, workUnitType: { reference: 1 } }],
        },
      },
    };
    const { entries, stats } = buildRegularTimesPayload(report, []);

    expect(entries).toHaveLength(0);
    expect(stats.dropped).toBe(1);
  });

  it("adds a new activity as one extra line without touching the others", () => {
    const { entries, stats } = buildRegularTimesPayload(LIVE_REPORT, [lot1Arabe({ workUnitType: { reference: 3 } })]);

    expect(entries).toHaveLength(7);
    expect(stats.newRows).toBe(1);
    expect(entries.at(-1)).toMatchObject({ row: -1, startDate: "2026-08-31" });
  });
});

describe("buildExceptionalTimesPayload / existingCollection", () => {
  const report: JsonApiResponse = {
    data: {
      id: "525",
      type: "timesreport",
      attributes: {
        exceptionalTimes: [
          {
            id: "500",
            startDate: "2026-08-03",
            endDate: "2026-08-03",
            description: "RTT",
            workUnitType: { reference: 8, name: "RTT" },
            delivery: { id: "120", title: "" },
            batch: null,
            project: { id: "25", reference: "DIGITAL LAB" },
          },
        ],
        workplaceTimes: [
          {
            id: "77",
            startDate: "2026-08-03",
            duration: 1,
            row: 12,
            workplaceType: { reference: 2, name: "Télétravail" },
          },
        ],
      },
    },
  };

  it("preserves stored exceptional times when adding one", () => {
    const { entries, preserved } = buildExceptionalTimesPayload(report, [
      {
        startDate: "2026-08-04",
        endDate: "2026-08-04",
        description: "RTT",
        workUnitType: { reference: 8 },
        delivery: { id: "120" },
        batch: { data: null },
        project: { id: "25" },
      },
    ]);

    expect(preserved).toBe(1);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ id: "500", workUnitType: { reference: 8 } });
  });

  it("echoes untouched collections in PUT-body shape", () => {
    expect(existingCollection(report, "exceptionalTimes")).toEqual([
      {
        id: "500",
        startDate: "2026-08-03",
        endDate: "2026-08-03",
        description: "RTT",
        workUnitType: { reference: 8 },
        delivery: { id: "120" },
        batch: { data: null },
        project: { id: "25" },
      },
    ]);
    expect(existingCollection(report, "workplaceTimes")).toEqual([
      {
        id: "77",
        startDate: "2026-08-03",
        duration: 1,
        row: 12,
        workplaceType: { reference: 2, name: "Télétravail" },
      },
    ]);
  });
});
