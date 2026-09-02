import { beforeEach, describe, expect, it } from "vitest";
import { useParkingStore } from "./parkingStore";

beforeEach(() => useParkingStore.getState().reset());

describe("parkingStore", () => {
  it("selects a record", () => {
    useParkingStore.getState().select("p1");
    expect(useParkingStore.getState().selectedParkedId).toBe("p1");
  });

  it("arms and disarms the map picker", () => {
    useParkingStore.getState().setPicking(true);
    expect(useParkingStore.getState().picking).toBe(true);
    useParkingStore.getState().setPicking(false);
    expect(useParkingStore.getState().picking).toBe(false);
  });

  it("disarms the picker when coordinates arrive", () => {
    useParkingStore.getState().setPicking(true);
    useParkingStore.getState().setPickedCoords([6.6, 51.55]);
    expect(useParkingStore.getState().picking).toBe(false);
    expect(useParkingStore.getState().pickedCoords).toEqual([6.6, 51.55]);
  });

  it("resets every field", () => {
    useParkingStore.getState().select("p1");
    useParkingStore.getState().setPicking(true);
    useParkingStore.getState().setPickedCoords([6.6, 51.55]);
    useParkingStore.getState().reset();
    expect(useParkingStore.getState()).toMatchObject({
      selectedParkedId: null,
      picking: false,
      pickedCoords: null,
    });
  });
});
