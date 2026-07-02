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
  });

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
    const updateCall = vi.mocked(server.registerTool).mock.calls.find((c) => c[0] === "boond_timesheets_update");
    const handler = updateCall?.[2] as (params: unknown) => Promise<{ content: unknown; structuredContent: unknown }>;

    vi.mocked(apiRequest).mockResolvedValueOnce({
      data: { id: "42", type: "timesreport", attributes: {} },
    });

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

    expect(apiRequest).toHaveBeenCalledWith(
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
});
