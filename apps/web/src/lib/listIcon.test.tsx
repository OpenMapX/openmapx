import { render } from "@testing-library/react";
import { expect, it } from "vitest";
import { listMarkerIcon, resolveListIcon } from "./listIcon";

it.each(["heart", "flag", "star", "bookmark", null, "unknown"])(
  "uses the saved-panel glyph for %s markers",
  (icon) => {
    const view = render(resolveListIcon(icon));
    expect(listMarkerIcon(icon)).toEqual({
      path: view.container.querySelector("path")?.getAttribute("d"),
    });
  },
);

it.each(["🏕️", "👩🏽‍🚀", "1️⃣"])("keeps the complete emoji %s", (emoji) => {
  const view = render(resolveListIcon(emoji));
  expect(view.container.textContent).toBe(emoji);
  expect(listMarkerIcon(emoji)).toEqual({ emoji });
});
