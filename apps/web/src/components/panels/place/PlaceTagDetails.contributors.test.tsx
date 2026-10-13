import { expect, it, vi } from "vitest";
import { render, screen } from "@/test";
import { PlaceTagDetails } from "./PlaceTagDetails";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
it("credits actual tag rows, excluding hidden negative rows, duplicate email and other sections", () => {
  const tags = {
    delivery: "yes",
    drive_through: "no",
    email: "same@example.com",
    note: "Note",
    brand: "Same",
    operator: "Same",
  };
  const receipt = (name: string) => [{ sourceId: name, name }];
  const place = {
    contributors: [],
    fieldContributors: {
      "osmTags.delivery": receipt("Delivery source"),
      "osmTags.drive_through": receipt("Hidden drive-through source"),
      "osmTags.email": receipt("Duplicate email source"),
      "osmTags.note": receipt("Note source"),
      "osmTags.brand": receipt("Hidden brand source"),
      "osmTags.operator": receipt("Operator source"),
    },
  };
  const view = render(
    <PlaceTagDetails
      osmTags={tags}
      section="practical"
      representedEmail="same@example.com"
      place={place}
    />,
  );
  expect(screen.getByText("Delivery source")).toBeTruthy();
  expect(screen.queryByText("Hidden drive-through source")).toBeNull();
  expect(screen.queryByText("Duplicate email source")).toBeNull();
  expect(screen.queryByText("Note source")).toBeNull();
  view.rerender(<PlaceTagDetails osmTags={tags} section="remaining" place={place} />);
  expect(screen.getByText("Note source")).toBeTruthy();
  expect(screen.getByText("Operator source")).toBeTruthy();
  expect(screen.queryByText("Hidden brand source")).toBeNull();
  expect(screen.queryByText("Delivery source")).toBeNull();
});
