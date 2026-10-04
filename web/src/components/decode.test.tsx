import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { FlowStrip } from "./decode.js";

describe("FlowStrip sorter animation", () => {
  it("marks the running stage with data-status and aria-current", () => {
    const { container } = render(
      <FlowStrip
        stages={[
          { key: "collect", label: "collect", status: "done" },
          { key: "sort_classify", label: "sort classify", status: "running", jev: true },
          { key: "score", label: "score", status: "pending" },
        ]}
      />,
    );
    const running = container.querySelector('li[data-status="running"]');
    expect(running?.textContent).toContain("sort classify");
    expect(running?.getAttribute("aria-current")).toBe("step");
    expect(screen.getByRole("list", { name: "Run stages" })).not.toBeNull();
  });
});
