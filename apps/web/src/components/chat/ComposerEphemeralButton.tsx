import { T, useGT } from "gt-react";
import { MessageCircleDashedIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";
import { ComposerControl } from "./ComposerControl";

interface ComposerEphemeralButtonProps {
  readonly active: boolean;
  readonly mode: "draft" | "server";
  readonly disabled?: boolean | undefined;
  readonly onToggle: () => void;
}

export function ComposerEphemeralButton({
  active,
  mode,
  disabled = false,
  onToggle,
}: ComposerEphemeralButtonProps) {
  const gt = useGT();
  const ariaLabel = active
    ? mode === "server"
      ? gt("Keep ephemeral chat permanently")
      : gt("Disable ephemeral chat")
    : mode === "server"
      ? gt("New ephemeral chat")
      : gt("Enable ephemeral chat");
  const tooltipLabel = active ? (
    mode === "server" ? (
      <T>Ephemeral chat. Deletes when you leave. Click to keep permanently.</T>
    ) : (
      <T>Ephemeral chat. Deletes when you leave. Click to turn off.</T>
    )
  ) : mode === "server" ? (
    <T>New ephemeral chat. Deletes when you leave.</T>
  ) : (
    <T>Ephemeral chat. Deletes when you leave.</T>
  );

  return (
    <SharedTooltipTrigger
      render={
        <ComposerControl
          type="button"
          aria-label={ariaLabel}
          aria-pressed={active}
          data-testid="composer-ephemeral-toggle"
          data-ephemeral-active={active ? "true" : "false"}
          disabled={disabled}
          onPointerDown={(event) => {
            event.preventDefault();
          }}
          onClick={onToggle}
          className={cn(
            "transition-[background-color,border-color,color,padding] duration-150 motion-reduce:transition-none",
            active
              ? "border-dashed border-border/90 bg-accent/85 px-2 text-accent-foreground hover:bg-accent"
              : "size-7 px-0 text-muted-foreground hover:text-foreground",
          )}
        />
      }
      label={tooltipLabel}
    >
      <MessageCircleDashedIcon
        aria-hidden="true"
        className={cn(active ? "size-3.5 text-foreground" : "size-4")}
        data-composer-control-icon
      />
      {active ? (
        <span data-composer-control-label className="text-xs font-medium">
          <T>Ephemeral</T>
        </span>
      ) : null}
    </SharedTooltipTrigger>
  );
}
