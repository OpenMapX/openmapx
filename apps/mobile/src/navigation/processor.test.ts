import { groundSessionFixture } from "../storage/testing/sessionFixture";
import { GroundNavigationProcessor } from "./ground/GroundNavigationProcessor";
import { ProcessorRegistry } from "./processor";
import { TransitNavigationProcessor } from "./transit/TransitNavigationProcessor";
import { transitSessionFixture } from "./transit/testing/transitFixture";

describe("ProcessorRegistry", () => {
  it("reports only the modes that have a registered processor", () => {
    const registry = new ProcessorRegistry();
    const ground = new GroundNavigationProcessor();
    registry.register(ground);

    expect(registry.supports("ground")).toBe(true);
    expect(registry.supports("transit")).toBe(false);
    expect(registry.get("ground")).toBe(ground);
    expect(registry.get("transit")).toBeNull();
  });

  it("hands each session to the processor of its own mode", () => {
    const registry = new ProcessorRegistry();
    const ground = new GroundNavigationProcessor();
    const transit = new TransitNavigationProcessor();
    registry.register(ground);
    registry.register(transit);

    const names = new Map<object, string>([
      [ground, "ground"],
      [transit, "transit"],
    ]);
    const seen = (session: Parameters<ProcessorRegistry["withProcessor"]>[0]) =>
      registry.withProcessor(session, (processor, typed) => ({
        processor: names.get(processor),
        session: typed.kind,
      }));

    expect(seen(groundSessionFixture())).toEqual({ processor: "ground", session: "ground" });
    expect(seen(transitSessionFixture())).toEqual({ processor: "transit", session: "transit" });
  });

  it("returns null without calling back when the session's mode has no processor", () => {
    const registry = new ProcessorRegistry();
    registry.register(new GroundNavigationProcessor());
    const callback = jest.fn();

    expect(registry.withProcessor(transitSessionFixture(), callback)).toBeNull();
    expect(callback).not.toHaveBeenCalled();
  });
});
