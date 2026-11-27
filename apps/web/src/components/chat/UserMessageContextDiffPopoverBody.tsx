import { FileDiff } from "@pierre/diffs/react";
import { useMessages } from "gt-react";
import { useRenderedAppearance } from "../../hooks/useTheme";
import {
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "../../lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "../../lib/syntaxHighlighting";
import {
  buildReviewCommentRenderablePatch,
  type ReviewCommentContext,
} from "../../reviewCommentContext";
import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider";

export default function UserMessageContextDiffPopoverBody({
  comment,
}: {
  readonly comment: ReviewCommentContext;
}) {
  const m = useMessages();
  const renderedAppearance = useRenderedAppearance();
  const renderablePatch = getRenderablePatch(
    buildReviewCommentRenderablePatch(comment),
    `review-comment:${comment.id}`,
    undefined,
    m,
  );
  if (renderablePatch?.kind === "files") {
    return (
      <DiffWorkerPoolProvider>
        {renderablePatch.files.map((fileDiff) => (
          <FileDiff
            key={resolveFileDiffPath(fileDiff)}
            fileDiff={fileDiff}
            options={{
              collapsed: false,
              diffStyle: "unified",
              theme: resolveDiffThemeName(renderedAppearance),
              preferredHighlighter: PREFERRED_HIGHLIGHTER,
            }}
          />
        ))}
      </DiffWorkerPoolProvider>
    );
  }
  if (renderablePatch?.kind === "raw") {
    return (
      <pre className="overflow-x-auto rounded-md bg-muted/40 p-2 text-xs">
        {renderablePatch.text}
      </pre>
    );
  }
  return null;
}
