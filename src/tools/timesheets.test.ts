import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTimesheetTools } from "./timesheets.js";
import { apiRequest } from "../services/boond-client.js";

vi.mock("../services/boond-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/boond-client.js")>();
  return { ...actual, apiRequest: vi.fn() };
});

function createMockServer() {
  return {
    registerTool: vi.fn(),
  } as unknown as McpServer;
}

describe("registerTimesheetTools", () => {
  let server: McpServer;

  beforeEach(() => {
    server = createMockServer();
    vi.mocked(apiRequest).mockReset();
  });

  /** Grab a registered tool's handler. */
  function handlerOf(name: string) {
    const call = vi.mocked(server.registerTool).mock.calls.find((c) => c[0] === name);
    if (!call) throw new Error(`tool ${name} not registered`);
    return call[2] as (params: unknown) => Promise<{ content: unknown; structuredContent?: unknown }>;
  }

  it("should register 5 timesheet tools", () => {
    registerTimesheetTools(server);
    expect(server.registerTool).toHaveBeenCalledTimes(5);
  });

  it("should register boond_resources_timesheets tool", () => {
    registerTimesheetTools(server);
    const names = vi.mocked(server.registerTool).mock.calls.map((c) => c[0]);
    expect(names).toContain("boond_resources_timesheets");
  });

  it("should register boond_timesheets_search tool", () => {
    registerTimesheetTools(server);
    const names = vi.mocked(server.registerTool).mock.calls.map((c) => c[0]);
    expect(names).toContain("boond_timesheets_search");
  });

  it("should register boond_timesheets_create tool", () => {
    registerTimesheetTools(server);
    const names = vi.mocked(server.registerTool).mock.calls.map((c) => c[0]);
    expect(names).toContain("boond_timesheets_create");
  });

  it("should register boond_timesheets_get tool", () => {
    registerTimesheetTools(server);
    const names = vi.mocked(server.registerTool).mock.calls.map((c) => c[0]);
    expect(names).toContain("boond_timesheets_get");
  });

  it("should register boond_timesheets_update tool", () => {
    registerTimesheetTools(server);
    const names = vi.mocked(server.registerTool).mock.calls.map((c) => c[0]);
    expect(names).toContain("boond_timesheets_update");
  });

  it("should register read tools as readOnly and create as write", () => {
    registerTimesheetTools(server);
    const calls = vi.mocked(server.registerTool).mock.calls;
    expect(calls.find((c) => c[0] === "boond_timesheets_create")?.[1].annotations?.readOnlyHint).toBe(false);
    expect(calls.find((c) => c[0] === "boond_timesheets_search")?.[1].annotations?.readOnlyHint).toBe(true);
    expect(calls.find((c) => c[0] === "boond_timesheets_get")?.[1].annotations?.readOnlyHint).toBe(true);
    expect(calls.find((c) => c[0] === "boond_resources_timesheets")?.[1].annotations?.readOnlyHint).toBe(true);
  });

  it("should register update tool as idempotent and non-destructive", () => {
    registerTimesheetTools(server);
    const updateCall = vi.mocked(server.registerTool).mock.calls.find((c) => c[0] === "boond_timesheets_update");
    expect(updateCall?.[1].annotations?.readOnlyHint).toBe(false);
    expect(updateCall?.[1].annotations?.destructiveHint).toBe(false);
    expect(updateCall?.[1].annotations?.idempotentHint).toBe(true);
  });

  it("should send a PUT request to /times-reports/{id} on update", async () => {
    registerTimesheetTools(server);
    const handler = handlerOf("boond_timesheets_update");

    // GET (row resolution) then PUT.
    vi.mocked(apiRequest)
      .mockResolvedValueOnce({ data: { id: "42", type: "timesreport", attributes: {} } })
      .mockResolvedValueOnce({ data: { id: "42", type: "timesreport", attributes: {} } });

    await handler({
      id: "42",
      workUnitRate: 50,
      regularTimes: [
        {
          startDate: "2026-07-01",
          duration: 1,
          row: -1,
          workUnitType: { reference: 1 },
          delivery: { data: null },
          batch: { data: null },
          project: { id: "10" },
        },
      ],
    });

    expect(apiRequest).toHaveBeenLastCalledWith(
      "/times-reports/42",
      "PUT",
      expect.objectContaining({
        data: expect.objectContaining({
          type: "timesreport",
          id: "42",
          attributes: expect.objectContaining({ workUnitRate: 50 }),
        }),
      })
    );
  });

  it("should reuse the existing activity row instead of creating a duplicate line", async () => {
    registerTimesheetTools(server);
    const handler = handlerOf("boond_timesheets_update");

    vi.mocked(apiRequest)
      .mockResolvedValueOnce({
        data: {
          id: "42",
          type: "timesreport",
          attributes: {
            regularTimes: [
              {
                id: "900",
                row: 55,
                startDate: "2026-07-01",
                duration: 1,
                workUnitType: { reference: 1 },
                delivery: { data: null },
                batch: { data: null },
                project: { data: { id: "10", type: "project" } },
              },
            ],
          },
        },
      })
      .mockResolvedValueOnce({ data: { id: "42", type: "timesreport", attributes: {} } });

    const result = await handler({
      id: "42",
      regularTimes: [
        {
          startDate: "2026-07-02",
          duration: 1,
          workUnitType: { reference: 1 },
          delivery: { data: null },
          batch: { data: null },
          project: { id: "10" },
        },
      ],
    });

    expect(vi.mocked(apiRequest).mock.calls[0]).toEqual(["/times-reports/42"]);
    const body = vi.mocked(apiRequest).mock.calls[1][2] as {
      data: { attributes: { regularTimes: Array<{ row: number; id?: string }> } };
    };
    expect(body.data.attributes.regularTimes).toHaveLength(2);
    expect(body.data.attributes.regularTimes[0]).toMatchObject({ id: "900", row: 55 });
    expect(body.data.attributes.regularTimes[1].row).toBe(55);
    expect(body.data.attributes.regularTimes[1].id).toBeUndefined();
    expect((result.content as Array<{ text: string }>)[0].text).toContain("conservé(s)");
  });

  it("should read the timesheet even when every row is explicitly pinned", async () => {
    registerTimesheetTools(server);
    const handler = handlerOf("boond_timesheets_update");

    vi.mocked(apiRequest)
      .mockResolvedValueOnce({
        data: {
          id: "42",
          type: "timesreport",
          attributes: {
            regularTimes: [
              {
                id: "900",
                startDate: "2026-07-01",
                duration: 1,
                row: 55,
                workUnitType: { reference: 1 },
                delivery: { data: null },
                batch: { data: null },
                project: { id: "10" },
              },
            ],
          },
        },
      })
      .mockResolvedValueOnce({ data: { id: "42", type: "timesreport", attributes: {} } });

    await handler({
      id: "42",
      regularTimes: [
        {
          startDate: "2026-07-02",
          duration: 1,
          row: 55,
          workUnitType: { reference: 1 },
          delivery: { data: null },
          batch: { data: null },
          project: { id: "10" },
        },
      ],
    });

    // Pinning a row does not make the read optional: `regularTimes` replaces the
    // whole collection, so the stored entries must travel in the body too.
    expect(apiRequest).toHaveBeenCalledTimes(2);
    expect(vi.mocked(apiRequest).mock.calls[0]).toEqual(["/times-reports/42"]);
    const body = vi.mocked(apiRequest).mock.calls[1][2] as {
      data: { attributes: { regularTimes: Array<{ id?: string; startDate: string }> } };
    };
    expect(body.data.attributes.regularTimes.map((e) => e.startDate)).toEqual(["2026-07-01", "2026-07-02"]);
  });

  it("should skip the read when no time collection is sent", async () => {
    registerTimesheetTools(server);
    const handler = handlerOf("boond_timesheets_update");

    vi.mocked(apiRequest).mockResolvedValueOnce({ data: { id: "42", type: "timesreport", attributes: {} } });

    await handler({ id: "42", workUnitRate: 50 });

    expect(apiRequest).toHaveBeenCalledTimes(1);
    expect(vi.mocked(apiRequest).mock.calls[0][1]).toBe("PUT");
  });

  it("should abort instead of writing when the pre-read fails", async () => {
    registerTimesheetTools(server);
    const handler = handlerOf("boond_timesheets_update");

    vi.mocked(apiRequest).mockRejectedValueOnce(new Error("403 Forbidden"));

    // Writing blind would replace the collection with just the caller's entry,
    // deleting every other day — so the update must not happen at all.
    await expect(
      handler({
        id: "42",
        regularTimes: [
          {
            startDate: "2026-07-01",
            duration: 1,
            workUnitType: { reference: 1 },
            delivery: { data: null },
            batch: { data: null },
            project: { id: "10" },
          },
        ],
      })
    ).rejects.toThrow(/Mise à jour annulée/);

    expect(apiRequest).toHaveBeenCalledTimes(1);
    expect(vi.mocked(apiRequest).mock.calls[0]).toEqual(["/times-reports/42"]);
  });

  it("should return the entity reference as structuredContent on update", async () => {
    registerTimesheetTools(server);
    const handler = handlerOf("boond_timesheets_update");

    vi.mocked(apiRequest).mockResolvedValueOnce({ data: { id: "42", type: "timesreport", attributes: {} } });

    const result = await handler({ id: "42", workUnitRate: 50 });

    expect(result.structuredContent).toEqual({ id: "42", type: "timesreport" });
  });
});
