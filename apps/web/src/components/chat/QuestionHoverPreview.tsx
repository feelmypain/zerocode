import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { observeResize } from "~/lib/observeResize";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const TRUNCATION_EPSILON_PX = 1;

interface QuestionHoverPreviewProps {
  readonly children: ReactNode;
  readonly previewContent?: ReactNode;
  readonly className?: string;
  readonly dir?: "ltr" | "rtl" | "auto" | undefined;
  readonly side?: "top" | "bottom" | "left" | "right";
  readonly align?: "start" | "center" | "end";
  readonly forceReveal?: boolean;
}

export function QuestionHoverPreview({
  children,
  previewContent,
  className,
  dir,
  side = "top",
  align = "start",
  forceReveal = false,
}: QuestionHoverPreviewProps) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const [truncated, setTruncated] = useState(false);

  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- measures DOM overflow via ResizeObserver and MutationObserver so hover reveal activates only when text truncates
  useLayoutEffect(() => {
    const element = triggerRef.current;
    if (!element) return;
    const measure = () => {
      setTruncated(element.scrollWidth > element.clientWidth + TRUNCATION_EPSILON_PX);
    };
    measure();
    const stopResize = observeResize(element, measure);
    const mutations = new MutationObserver(measure);
    mutations.observe(element, { childList: true, subtree: true, characterData: true });
    return () => {
      stopResize();
      mutations.disconnect();
    };
  }, []);

  const canReveal = forceReveal || truncated;

  return (
    <Tooltip disabled={!canReveal}>
      <TooltipTrigger
        delay={140}
        closeDelay={140}
        render={
          <span
            ref={triggerRef}
            dir={dir}
            data-question-truncated={canReveal ? "true" : undefined}
            className={className}
          />
        }
      >
        {children}
      </TooltipTrigger>
      {canReveal ? (
        <TooltipPopup
          variant="preview"
          side={side}
          align={align}
          sideOffset={8}
          data-question-hover-preview="true"
        >
          <div dir={dir} className="whitespace-pre-wrap wrap-anywhere">
            {previewContent ?? children}
          </div>
        </TooltipPopup>
      ) : null}
    </Tooltip>
  );
}
