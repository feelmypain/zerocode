import "~/index.css";

import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";
import { ComposerEphemeralButton } from "./ComposerEphemeralButton";

it("toggles between icon-only inactive and active ephemeral pill states in draft mode", async () => {
  const onToggle = vi.fn();
  await using screen = await render(
    <ComposerEphemeralButton active={false} mode="draft" onToggle={onToggle} />,
  );

  const button = screen.getByTestId("composer-ephemeral-toggle").element() as HTMLButtonElement;
  expect(button.getAttribute("aria-pressed")).toBe("false");
  expect(button.getAttribute("aria-label")).toBe("Enable ephemeral chat");
  expect(button.textContent).toBe("");

  await act(() => button.click());
  expect(onToggle).toHaveBeenCalledTimes(1);

  await screen.rerender(<ComposerEphemeralButton active mode="draft" onToggle={onToggle} />);
  expect(button.getAttribute("aria-pressed")).toBe("true");
  expect(button.getAttribute("aria-label")).toBe("Disable ephemeral chat");
  expect(button.textContent).toContain("Ephemeral");
});

it("offers keeping an active ephemeral server thread and respects read-only disabled state", async () => {
  const onToggle = vi.fn();
  await using screen = await render(
    <ComposerEphemeralButton active mode="server" onToggle={onToggle} />,
  );

  const button = screen.getByTestId("composer-ephemeral-toggle").element() as HTMLButtonElement;
  expect(button.getAttribute("aria-pressed")).toBe("true");
  expect(button.getAttribute("aria-label")).toBe("Keep ephemeral chat permanently");
  expect(button.disabled).toBe(false);

  await act(() => button.click());
  expect(onToggle).toHaveBeenCalledTimes(1);

  await screen.rerender(
    <ComposerEphemeralButton active mode="server" disabled onToggle={onToggle} />,
  );
  expect(button.disabled).toBe(true);
});
