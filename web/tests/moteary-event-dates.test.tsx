import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validEventDate } from "@/components/MotearyWorkspace/eventDates";
import MemoDates from "@/components/MotearyWorkspace/MemoDates";
import { buildSourceFilter } from "@/components/MotearyWorkspace/sources";

vi.mock("@/connect", () => ({ getRequestToken: async () => "synthetic-token" }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const value = { eventDate: "2026-11-14", capturedAt: "2026-11-19T07:00:00Z", captureTimeBasis: "captured" };
const reply = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

describe("calendar dates independent of timezone", () => {
  it("validates Gregorian days without timezone conversion", () => {
    for (const input of ["2024-02-29", "2000-02-29", "0001-01-01", "9999-12-31", "2026-11-14"]) expect(validEventDate(input)).toBe(true);
    for (const input of ["2026-02-29", "1900-02-29", "0000-01-01", "2026-04-31", "2026-1-01", "2026-11-14T00:00:00Z", ""])
      expect(validEventDate(input)).toBe(false);
  });
  it("preserves calendar literals in Shanghai and Los Angeles while retaining owner and space before pagination", () => {
    const previous = process.env.TZ;
    try {
      for (const timezone of ["Asia/Shanghai", "America/Los_Angeles"]) {
        process.env.TZ = timezone;
        const filter = buildSourceFilter("users/synthetic", "work", "spaces/synthetic", "同一岗位", {
          eventFrom: "2026-11-14",
          eventThrough: "2026-11-16",
        });
        expect(filter).toContain('event_date >= "2026-11-14"');
        expect(filter).toContain('event_date <= "2026-11-16"');
        expect(filter).toContain('creator == "users/synthetic"');
        expect(filter).toContain('space == "spaces/synthetic"');
        expect(filter).toContain('content.contains("同一岗位")');
        expect(filter).not.toContain("timestamp(");
      }
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });
  it("keeps old unknown records in default view and supports explicit unknown without accidental upper-bound inclusion", () => {
    expect(buildSourceFilter("users/synthetic", "all")).not.toContain("event_date");
    expect(buildSourceFilter("users/synthetic", "all", undefined, "", { eventUnknown: true })).toContain('event_date == ""');
    expect(buildSourceFilter("users/synthetic", "all", undefined, "", { eventThrough: "2026-11-14" })).toContain('event_date != ""');
    expect(() => buildSourceFilter("users/synthetic", "all", undefined, "", { eventFrom: "2026-02-29" })).toThrow();
    expect(() =>
      buildSourceFilter("users/synthetic", "all", undefined, "", { eventFrom: "2026-11-15", eventThrough: "2026-11-14" }),
    ).toThrow();
  });
});

describe("record date editing", () => {
  it("displays exact date, saves corrections and clears without sending capture time or content", async () => {
    const calls: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init: RequestInit) => {
        calls.push(init);
        return reply({ ...value, eventDate: init.method === "PATCH" ? JSON.parse(String(init.body)).eventDate : value.eventDate });
      }),
    );
    const changed = vi.fn();
    render(<MemoDates name="memos/synthetic" onChanged={changed} />);
    await screen.findByText("事件日期：2026-11-14");
    expect(screen.getByText(/采集时间（只读）/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("事件发生日期"), { target: { value: "2024-02-29" } });
    fireEvent.click(screen.getByRole("button", { name: "保存日期" }));
    await screen.findByText("事件日期：2024-02-29");
    expect(JSON.parse(String(calls[1].body))).toEqual({ eventDate: "2024-02-29" });
    fireEvent.click(screen.getByRole("button", { name: "清除事件日期" }));
    await screen.findByText("事件日期：未知（未填写）");
    expect(JSON.parse(String(calls[2].body))).toEqual({ eventDate: null });
    expect(changed).toHaveBeenCalledTimes(2);
    expect(document.querySelector("time")?.getAttribute("datetime")).toBe(value.capturedAt);
  });
  it("labels legacy creation time honestly and hides stale metadata on read failure", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(reply({ ...value, eventDate: null, captureTimeBasis: "legacy-created" }))
      .mockResolvedValueOnce(reply({}, 404));
    vi.stubGlobal("fetch", fetch);
    render(<MemoDates name="memos/legacy" onChanged={vi.fn()} />);
    await screen.findByText(/历史记录时间（非原始采集凭证）/);
    fireEvent.click(screen.getByRole("button", { name: "保存日期" }));
    await screen.findByRole("alert");
    expect(screen.queryByText(/历史记录时间（非原始采集凭证）/)).not.toBeInTheDocument();
    expect(screen.getByText("事件日期：尚未读取")).toBeInTheDocument();
  });
  it("aborts pending load when account/card unmounts and ignores its late result", async () => {
    let resolve!: (response: Response) => void;
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url, init: RequestInit) => {
        signal = init.signal as AbortSignal;
        return new Promise<Response>((r) => {
          resolve = r;
        });
      }),
    );
    const changed = vi.fn();
    const mounted = render(<MemoDates name="memos/synthetic" onChanged={changed} />);
    await waitFor(() => expect(resolve).toBeDefined());
    mounted.unmount();
    expect(signal?.aborted).toBe(true);
    resolve(reply(value));
    expect(changed).not.toHaveBeenCalled();
  });
});
