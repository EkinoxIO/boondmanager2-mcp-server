/**
 * Payload reconciliation for `boond_timesheets_update` (PUT /times-reports/{id}).
 *
 * Two BoondManager behaviours drive everything here.
 *
 * 1. A timesheet is a set of *activity lines* (`TAB_LIGNETEMPS`, addressed by
 *    `row`) each holding one time entry per day (`TAB_TEMPS`, addressed by
 *    `id`). A line is identified by `workUnitType.reference` + `delivery` +
 *    `batch` + `project`. A `row <= -1` always creates a *new* line, so a
 *    caller that doesn't know the existing row numbers duplicates an activity
 *    that is already there.
 *
 * 2. `attributes.regularTimes` is a **full replacement of the collection**, not
 *    a patch. Sending one entry means "this timesheet now has exactly one
 *    entry" — every other day is deleted. Verified the hard way against a live
 *    timesheet: a single-entry PUT wiped 20 entries across 4 lines.
 *
 * So an update must send the *union*: every stored entry, plus the caller's
 * changes applied on top. That is what `buildRegularTimesPayload` does:
 *   - an activity already present reuses its existing `row` (append a day),
 *   - a day already filled reuses that entry's `id` and the incoming duration
 *     replaces the stored one,
 *   - only a genuinely new activity gets a fresh negative `row`,
 *   - every untouched entry is echoed back verbatim so Boond keeps it.
 *
 * A `row >= 1` supplied by the caller is honoured verbatim (explicit pin), but
 * it never skips the read: skipping would drop the untouched entries.
 */

import type { JsonApiResponse, JsonApiResource } from "../types.js";

type Entry = Record<string, unknown>;

/** Existing lines/entries of a timesheet, indexed for lookup. */
export interface TimesReportIndex {
  /** activity key → existing `row` (positive line id). */
  rowByKey: Map<string, number>;
  /** `activityKey@YYYY-MM-DD` → existing regular time entry id. */
  regularIdByKeyDate: Map<string, string>;
  /** `activityKey@YYYY-MM-DD` → existing exceptional time entry id. */
  exceptionalIdByKeyDate: Map<string, string>;
}

export interface ResolutionStats {
  /** Entries attached to an activity line that already existed. */
  reusedRows: number;
  /** Distinct new activity lines created by this call. */
  newRows: number;
  /** Entries whose duration/description overwrites an existing day. */
  replaced: number;
}

export interface PayloadStats extends ResolutionStats {
  /** Stored entries echoed back so the replace-semantics PUT keeps them. */
  preserved: number;
  /** Days added to the timesheet by this call. */
  appended: number;
  /** Stored entries that could not be echoed (no addressable `row`). */
  dropped: number;
}

/** Merge a JSON:API-ish `attributes` bag into the entry's own top-level keys. */
function flatten(entry: unknown): Entry {
  if (!entry || typeof entry !== "object") return {};
  const e = entry as Entry;
  const attrs = e.attributes;
  if (!attrs || typeof attrs !== "object") return e;
  const rest = { ...e };
  delete rest.attributes;
  return { ...(attrs as Entry), ...rest };
}

/**
 * Extract an id out of any of the shapes BoondManager uses for a relation:
 * `{ id }` (PUT body and, as it turns out, the GET response too), `{ data: { id } }`
 * (JSON:API), `{ data: null }` / `null` (no relation), or a bare id.
 */
export function relationId(rel: unknown): string {
  if (rel === null || rel === undefined) return "";
  if (typeof rel === "string" || typeof rel === "number") return String(rel);
  if (typeof rel !== "object") return "";
  const o = rel as Entry;
  if (o.id !== null && o.id !== undefined) return String(o.id);
  const data = o.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const id = (data as Entry).id;
    if (id !== null && id !== undefined) return String(id);
  }
  return "";
}

function workUnitReference(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "string") return String(value);
  if (typeof value !== "object") return "";
  const ref = (value as Entry).reference;
  return ref === null || ref === undefined ? "" : String(ref);
}

/** `YYYY-MM-DD`, tolerating an ISO datetime or an empty string. */
function normalizeDate(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 10) : "";
}

/** Read a relation off an entry, whether it sits inline or under `relationships`. */
function entryRelation(entry: Entry, name: string): unknown {
  const relations = entry.relationships as Entry | undefined;
  return entry[name] ?? relations?.[name];
}

/**
 * Identity of an activity line: work unit type + the three relations Boond
 * keys a line on. Two entries sharing this key belong on the same `row`.
 */
export function activityKey(entry: unknown): string {
  const e = flatten(entry);
  return [
    workUnitReference(e.workUnitType),
    relationId(entryRelation(e, "delivery")),
    relationId(entryRelation(e, "batch")),
    relationId(entryRelation(e, "project")),
  ].join("|");
}

function positiveRow(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 ? n : undefined;
}

/** The `row` of an already-stored entry, whatever field the API exposed it as. */
function existingRow(entry: Entry): number | undefined {
  const candidates = [
    entry.row,
    entry.rowId,
    positiveRow(relationId(entryRelation(entry, "line"))),
    positiveRow(relationId(entryRelation(entry, "timesRow"))),
  ];
  for (const candidate of candidates) {
    const row = positiveRow(candidate);
    if (row !== undefined) return row;
  }
  return undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Collect the time entries of one kind from `attributes` and from `included`. */
function collect(response: JsonApiResponse, attributeName: string, includedTypes: string[]): Entry[] {
  const data: JsonApiResource[] = Array.isArray(response.data) ? response.data : [response.data];
  const entries: Entry[] = [];

  for (const resource of data) {
    if (!resource) continue;
    for (const raw of asArray(resource.attributes?.[attributeName])) {
      entries.push(flatten(raw));
    }
  }

  for (const included of response.included ?? []) {
    const type = String(included?.type ?? "").toLowerCase();
    if (includedTypes.includes(type)) entries.push(flatten(included));
  }

  return entries;
}

const REGULAR_INCLUDED_TYPES = ["regulartime", "regulartimes", "time"];
const EXCEPTIONAL_INCLUDED_TYPES = ["exceptionaltime", "exceptionaltimes"];

/** Index the current state of a timesheet (`GET /times-reports/{id}`). */
export function indexTimesReport(response: JsonApiResponse): TimesReportIndex {
  const index: TimesReportIndex = {
    rowByKey: new Map(),
    regularIdByKeyDate: new Map(),
    exceptionalIdByKeyDate: new Map(),
  };

  for (const entry of collect(response, "regularTimes", REGULAR_INCLUDED_TYPES)) {
    const key = activityKey(entry);
    const row = existingRow(entry);
    if (row !== undefined && !index.rowByKey.has(key)) index.rowByKey.set(key, row);

    const date = normalizeDate(entry.startDate);
    if (date && entry.id !== undefined && entry.id !== null) {
      const dateKey = `${key}@${date}`;
      if (!index.regularIdByKeyDate.has(dateKey)) index.regularIdByKeyDate.set(dateKey, String(entry.id));
    }
  }

  for (const entry of collect(response, "exceptionalTimes", EXCEPTIONAL_INCLUDED_TYPES)) {
    const date = normalizeDate(entry.startDate);
    if (!date || entry.id === undefined || entry.id === null) continue;
    const dateKey = `${activityKey(entry)}@${date}`;
    if (!index.exceptionalIdByKeyDate.has(dateKey)) index.exceptionalIdByKeyDate.set(dateKey, String(entry.id));
  }

  return index;
}

/** A relation in PUT-body form: `{ id }`, or `{ data: null }` for no relation. */
function relationBody(rel: unknown): Entry {
  const id = relationId(rel);
  return id ? { id } : { data: null };
}

/**
 * Convert a stored regular time into the PUT body shape, dropping the
 * read-only decoration the API adds (`calendar`, relation `title`/dates, the
 * `activityType`/`name` of `workUnitType`) — the body schema is strict.
 *
 * Returns undefined when the entry has no addressable `row`: echoing it without
 * one would create a duplicate line instead of preserving it.
 */
export function toPutRegularTime(raw: unknown): Entry | undefined {
  const e = flatten(raw);
  const row = existingRow(e);
  const reference = Number(workUnitReference(e.workUnitType));
  if (row === undefined || !Number.isFinite(reference) || reference < 1) return undefined;

  const entry: Entry = {
    startDate: normalizeDate(e.startDate),
    duration: Number(e.duration ?? 0),
    row,
    workUnitType: { reference },
    delivery: relationBody(entryRelation(e, "delivery")),
    batch: relationBody(entryRelation(e, "batch")),
    project: relationBody(entryRelation(e, "project")),
  };
  if (e.id !== undefined && e.id !== null) entry.id = String(e.id);
  return entry;
}

/** Same, for an exceptional time. */
export function toPutExceptionalTime(raw: unknown): Entry | undefined {
  const e = flatten(raw);
  const reference = Number(workUnitReference(e.workUnitType));
  if (e.id === undefined || e.id === null || !Number.isFinite(reference) || reference < 1) return undefined;

  return {
    id: String(e.id),
    startDate: normalizeDate(e.startDate),
    endDate: normalizeDate(e.endDate) || normalizeDate(e.startDate),
    description: typeof e.description === "string" ? e.description : "",
    ...(typeof e.recovering === "boolean" ? { recovering: e.recovering } : {}),
    workUnitType: { reference },
    delivery: relationBody(entryRelation(e, "delivery")),
    batch: relationBody(entryRelation(e, "batch")),
    project: relationBody(entryRelation(e, "project")),
  };
}

/**
 * Rewrite incoming `regularTimes` so an existing activity is appended to
 * instead of duplicated. Entries carrying an explicit `row >= 1` pass through
 * untouched.
 */
export function resolveRegularTimes(
  entries: unknown[],
  index: TimesReportIndex
): { entries: Entry[]; stats: ResolutionStats } {
  const stats: ResolutionStats = { reusedRows: 0, newRows: 0, replaced: 0 };
  const newRowByKey = new Map<string, number>();
  let nextNewRow = -1;

  const resolved = entries.map((raw) => {
    const entry = { ...(raw as Entry) };
    if (positiveRow(entry.row) !== undefined) return entry;

    const key = activityKey(entry);
    const row = index.rowByKey.get(key);

    if (row !== undefined) {
      entry.row = row;
      stats.reusedRows += 1;
      if (entry.id === undefined || entry.id === null) {
        const timeId = index.regularIdByKeyDate.get(`${key}@${normalizeDate(entry.startDate)}`);
        if (timeId !== undefined) {
          entry.id = timeId;
          stats.replaced += 1;
        }
      }
      return entry;
    }

    // Unknown activity: one fresh negative row per distinct key, so two new
    // activities in the same call don't collide on `-1`.
    let assigned = newRowByKey.get(key);
    if (assigned === undefined) {
      assigned = nextNewRow--;
      newRowByKey.set(key, assigned);
      stats.newRows += 1;
    }
    entry.row = assigned;
    return entry;
  });

  return { entries: resolved, stats };
}

/**
 * The full `regularTimes` collection to PUT: every stored entry, with the
 * caller's entries merged on top. **This is what makes the update non-
 * destructive** — `regularTimes` replaces the collection server-side, so an
 * omitted day is a deleted day.
 */
export function buildRegularTimesPayload(
  current: JsonApiResponse,
  incoming: unknown[]
): { entries: Entry[]; stats: PayloadStats } {
  const index = indexTimesReport(current);
  const stored = collect(current, "regularTimes", REGULAR_INCLUDED_TYPES);

  // Keyed by line+day: that pair is what a single time entry occupies.
  const byRowDate = new Map<string, Entry>();
  let dropped = 0;
  for (const raw of stored) {
    const entry = toPutRegularTime(raw);
    if (!entry) {
      dropped += 1;
      continue;
    }
    byRowDate.set(`${entry.row}@${normalizeDate(entry.startDate)}`, entry);
  }
  const preserved = byRowDate.size;

  const { entries: resolved, stats } = resolveRegularTimes(incoming, index);
  let appended = 0;
  for (const entry of resolved) {
    const slot = `${entry.row}@${normalizeDate(entry.startDate)}`;
    const previous = byRowDate.get(slot);
    if (previous) {
      // Same line, same day: the incoming values win, but keep the stored
      // entry id so Boond updates that row instead of stacking a second one.
      byRowDate.set(slot, { ...previous, ...entry, ...(entry.id ? {} : { id: previous.id }) });
    } else {
      byRowDate.set(slot, entry);
      appended += 1;
    }
  }

  return {
    entries: [...byRowDate.values()],
    stats: { ...stats, preserved, appended, dropped },
  };
}

/**
 * Attach the existing entry id when an exceptional time already covers the
 * same activity on the same start date, so the update overwrites it instead of
 * stacking a duplicate.
 */
export function resolveExceptionalTimes(
  entries: unknown[],
  index: TimesReportIndex
): { entries: Entry[]; replaced: number } {
  let replaced = 0;

  const resolved = entries.map((raw) => {
    const entry = { ...(raw as Entry) };
    if (entry.id !== undefined && entry.id !== null) return entry;

    const dateKey = `${activityKey(entry)}@${normalizeDate(entry.startDate)}`;
    const existingId = index.exceptionalIdByKeyDate.get(dateKey);
    if (existingId !== undefined) {
      entry.id = existingId;
      replaced += 1;
    }
    return entry;
  });

  return { entries: resolved, replaced };
}

/** Same union treatment for `exceptionalTimes`. */
export function buildExceptionalTimesPayload(
  current: JsonApiResponse,
  incoming: unknown[]
): { entries: Entry[]; replaced: number; preserved: number } {
  const index = indexTimesReport(current);
  const byKeyDate = new Map<string, Entry>();

  for (const raw of collect(current, "exceptionalTimes", EXCEPTIONAL_INCLUDED_TYPES)) {
    const entry = toPutExceptionalTime(raw);
    if (entry) byKeyDate.set(`${activityKey(entry)}@${normalizeDate(entry.startDate)}`, entry);
  }
  const preserved = byKeyDate.size;

  const { entries: resolved, replaced } = resolveExceptionalTimes(incoming, index);
  for (const entry of resolved) {
    const slot = `${activityKey(entry)}@${normalizeDate(entry.startDate)}`;
    const previous = byKeyDate.get(slot);
    byKeyDate.set(slot, previous ? { ...previous, ...entry } : entry);
  }

  return { entries: [...byKeyDate.values()], replaced, preserved };
}

/**
 * Stored entries of a collection the caller did not send at all. They still
 * have to travel in the body: `regularTimes` absent leaves the collection
 * alone, but there is no evidence Boond treats a *sent* body's missing sibling
 * collections the same way, so echo whatever exists.
 */
export function existingCollection(current: JsonApiResponse, name: "exceptionalTimes" | "workplaceTimes"): unknown[] {
  if (name === "exceptionalTimes") {
    return collect(current, "exceptionalTimes", EXCEPTIONAL_INCLUDED_TYPES)
      .map(toPutExceptionalTime)
      .filter((entry): entry is Entry => entry !== undefined);
  }
  return collect(current, "workplaceTimes", ["workplacetime", "workplacetimes"]).map((raw) => {
    const e = flatten(raw);
    const workplaceType = (e.workplaceType ?? {}) as Entry;
    return {
      id: String(e.id ?? ""),
      startDate: normalizeDate(e.startDate),
      duration: Number(e.duration ?? 0),
      row: Number(e.row ?? 0),
      workplaceType: {
        reference: Number(workplaceType.reference ?? 0),
        name: String(workplaceType.name ?? ""),
      },
    };
  });
}

/**
 * True when the caller sent at least one time collection, i.e. the update
 * touches the replace-semantics attributes and therefore *must* read the
 * timesheet first. Kept as a named check so the intent is explicit: this is a
 * data-loss guard, not an optimisation.
 */
export function requiresReadBeforeWrite(attrs: Entry): boolean {
  return (
    Array.isArray(attrs.regularTimes) || Array.isArray(attrs.exceptionalTimes) || Array.isArray(attrs.workplaceTimes)
  );
}
