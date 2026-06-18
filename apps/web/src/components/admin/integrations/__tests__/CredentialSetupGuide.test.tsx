// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { render, screen, userEvent } from "@/test";
import { CredentialSetupGuide } from "../CredentialSetupGuide";

describe("CredentialSetupGuide", () => {
  it("renders a Get API key link to the registration URL", () => {
    render(<CredentialSetupGuide setup={{ url: "https://provider.example/keys" }} />);
    const link = screen.getByRole("link", { name: /get api key/i });
    expect(link.getAttribute("href")).toBe("https://provider.example/keys");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("drops an unsafe (javascript:) url instead of rendering a link", () => {
    const { container } = render(<CredentialSetupGuide setup={{ url: "javascript:alert(1)" }} />);
    expect(screen.queryByRole("link", { name: /get api key/i })).toBeNull();
    // url was the only field — nothing actionable remains, so render nothing.
    expect(container.innerHTML).toBe("");
  });

  it("uses a custom url label when provided", () => {
    render(<CredentialSetupGuide setup={{ url: "https://x.example", urlLabel: "Open console" }} />);
    expect(screen.queryByRole("link", { name: /open console/i })).not.toBeNull();
  });

  it("builds a mailto: link with subject and body pre-filled", () => {
    render(
      <CredentialSetupGuide
        setup={{
          email: { to: "api@provider.example", subject: "Access request", body: "Hello there" },
        }}
      />,
    );
    const href = screen.getByRole("link", { name: /email request/i }).getAttribute("href") ?? "";
    expect(href).toContain("mailto:api@provider.example");
    expect(href).toContain("subject=Access%20request");
    expect(href).toContain("body=Hello%20there");
  });

  it("shows the cost hint", () => {
    render(<CredentialSetupGuide setup={{ cost: "Free tier: 100k/mo" }} />);
    expect(screen.queryByText("Free tier: 100k/mo")).not.toBeNull();
  });

  it("hides the step list until expanded, then reveals it", async () => {
    const user = userEvent.setup();
    render(<CredentialSetupGuide setup={{ steps: ["First step", "Second step"] }} />);
    // Collapsed by default (unmountOnExit) — steps are not in the DOM.
    expect(screen.queryByText("First step")).toBeNull();
    await user.click(screen.getByRole("button", { name: /how to get this key/i }));
    expect(screen.queryByText("First step")).not.toBeNull();
    expect(screen.queryByText("Second step")).not.toBeNull();
  });

  it("shows steps immediately when defaultExpanded", () => {
    render(<CredentialSetupGuide setup={{ steps: ["Only step"] }} defaultExpanded />);
    expect(screen.queryByText("Only step")).not.toBeNull();
  });

  it("renders nothing when the setup block is empty", () => {
    const { container } = render(<CredentialSetupGuide setup={{}} />);
    expect(container.innerHTML).toBe("");
  });
});
