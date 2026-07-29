import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdminTableSurface } from "../AdminTableSurface";

describe("AdminTableSurface", () => {
  it("keeps context, controls, rows, and pagination in one surface", () => {
    const markup = renderToStaticMarkup(
      <AdminTableSurface
        title="Users"
        description="Account directory"
        toolbar={<button type="button">Search</button>}
        pagination={<div>Rows 1–25 of 80</div>}
      >
        <table>
          <tbody>
            <tr>
              <td>Florian</td>
            </tr>
          </tbody>
        </table>
      </AdminTableSurface>,
    );

    expect(markup).toContain("<section");
    expect(markup).toContain("Users");
    expect(markup).toContain("Account directory");
    expect(markup).toContain("Search");
    expect(markup).toContain("Florian");
    expect(markup).toContain("Rows 1–25 of 80");
    expect(markup.indexOf("Search")).toBeLessThan(markup.indexOf("Florian"));
    expect(markup.indexOf("Florian")).toBeLessThan(markup.indexOf("Rows 1–25 of 80"));
  });
});
