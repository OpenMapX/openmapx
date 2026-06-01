import { describe, expect, it } from "vitest";
import { defaultHotelDates, useHotelSearchStore } from "./hotelSearchStore";

describe("defaultHotelDates", () => {
  it("returns today and tomorrow as YYYY-MM-DD", () => {
    const { checkIn, checkOut } = defaultHotelDates(new Date("2026-05-31T10:00:00"));
    expect(checkIn).toBe("2026-05-31");
    expect(checkOut).toBe("2026-06-01");
  });
});

describe("useHotelSearchStore date invariant", () => {
  it("pushes check-out past check-in when check-in moves to/after it", () => {
    useHotelSearchStore.setState({ checkIn: "", checkOut: "2026-06-02" });
    useHotelSearchStore.getState().setCheckIn("2026-06-05");
    expect(useHotelSearchStore.getState().checkOut).toBe("2026-06-06");
  });
  it("rejects a check-out on/before check-in", () => {
    useHotelSearchStore.setState({ checkIn: "2026-06-10", checkOut: "2026-06-12" });
    useHotelSearchStore.getState().setCheckOut("2026-06-09");
    expect(useHotelSearchStore.getState().checkOut).toBe("2026-06-12");
  });
});
