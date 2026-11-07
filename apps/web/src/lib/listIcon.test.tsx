import { render } from "@testing-library/react";
import { expect, it } from "vitest";
import { listMarkerIcon, resolveListIcon } from "./listIcon";

it("uses the saved-panel glyph for markers", () => {
  const icon = "heart";
  const view = render(resolveListIcon(icon));
  expect(listMarkerIcon(icon)).toEqual({
    path: view.container.querySelector("path")?.getAttribute("d"),
  });
});

it.each(["🏕️", "👩🏽‍🚀", "1️⃣"])("keeps the complete emoji %s", (emoji) => {
  const view = render(resolveListIcon(emoji));
  expect(view.container.textContent).toBe(emoji);
  expect(listMarkerIcon(emoji)).toEqual({ emoji });
});
