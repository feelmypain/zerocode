import { thrownErrorMessage } from "@zerocode/client-runtime/errors";
import { settlePromise } from "@zerocode/client-runtime/state/runtime";
import type { DesktopSshPasswordPromptRequest } from "@zerocode/contracts";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Cause from "effect/Cause";
import { msg, T, useGT, Var } from "gt-react";
import { useId, useRef, useState, useSyncExternalStore } from "react";

import { m } from "../../i18n/messages";

import { useDeadlinePassed } from "../../hooks/useDeadline";
import { useNowSecond } from "../../hooks/useNowSecond";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import {
  readSshPasswordPromptQueue,
  removeSshPasswordPrompt,
  startSshPasswordPromptQueue,
  subscribeSshPasswordPromptQueue,
} from "./sshPasswordPromptState";

export { startSshPasswordPromptQueue };

function describeSshTarget(request: DesktopSshPasswordPromptRequest): string {
  return request.username ? `${request.username}@${request.destination}` : request.destination;
}

function formatRemainingSeconds(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function getPromptErrorMessage(error: unknown): string {
  const message = thrownErrorMessage(error, m) ?? m(msg("SSH verification prompt failed."));
  return message.includes("expired") || message.includes("no longer pending")
    ? m(msg("This SSH verification prompt expired. Try connecting again."))
    : message;
}

export function SshPasswordPromptDialog() {
  const queue = useSyncExternalStore(
    subscribeSshPasswordPromptQueue,
    readSshPasswordPromptQueue,
    readSshPasswordPromptQueue,
  );
  const currentRequest = queue[0] ?? null;

  if (!currentRequest) {
    return null;
  }

  return <ActiveSshPasswordPrompt key={currentRequest.requestId} request={currentRequest} />;
}

function ActiveSshPasswordPrompt({
  request,
}: {
  readonly request: DesktopSshPasswordPromptRequest;
}) {
  const gt = useGT();
  const [password, setPassword] = useState("");
  const [isResponding, setIsResponding] = useState(false);
  const [responseError, setResponseError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const isRespondingRef = useRef(false);
  const formId = useId();

  const expiresAtMs = Date.parse(request.expiresAt);
  const now = useNowSecond();
  const isExpired = useDeadlinePassed(Number.isFinite(expiresAtMs) ? expiresAtMs : null);
  const remainingMs = Number.isFinite(expiresAtMs)
    ? isExpired
      ? 0
      : Math.max(0, expiresAtMs - now)
    : null;
  const remainingSeconds = remainingMs === null ? null : Math.ceil(remainingMs / 1_000);
  const remainingLabel =
    remainingSeconds === null ? null : formatRemainingSeconds(remainingSeconds);
  const visibleResponseError = isExpired
    ? gt("This SSH verification prompt expired. Try connecting again.")
    : responseError;

  const respond = async (nextPassword: string | null) => {
    if (isRespondingRef.current) {
      return;
    }

    const requestId = request.requestId;
    if (nextPassword !== null && isExpired) {
      setResponseError(gt("This SSH verification prompt expired. Try connecting again."));
      return;
    }

    isRespondingRef.current = true;
    setIsResponding(true);
    setResponseError(null);
    const result = await settlePromise(async () =>
      window.desktopBridge?.resolveSshPasswordPrompt(requestId, nextPassword),
    );
    if (AsyncResult.isSuccess(result) || nextPassword === null) {
      removeSshPasswordPrompt(requestId);
    } else {
      setResponseError(getPromptErrorMessage(Cause.squash(result.cause)));
    }
    isRespondingRef.current = false;
    setIsResponding(false);
  };

  const dismissExpiredPrompt = () => {
    removeSshPasswordPrompt(request.requestId);
  };

  const cancelPrompt = () => {
    if (isExpired) {
      dismissExpiredPrompt();
      return;
    }
    void respond(null);
  };

  const target = describeSshTarget(request);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          cancelPrompt();
        }
      }}
    >
      <DialogPopup className="max-w-md" initialFocus={inputRef} showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            <T>SSH verification required</T>
          </DialogTitle>
          <DialogDescription>
            <T>
              Enter the password or verification code required by{" "}
              <code>
                <Var>{target}</Var>
              </code>
              . ZeroCode passes your response to the local SSH process and keeps it in memory to
              reuse for this host. ZeroCode does not write it to disk.
            </T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel scrollFade={false}>
          <form
            className="space-y-3"
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
              void respond(password);
            }}
          >
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-medium text-foreground">{request.prompt}</p>
                {remainingLabel ? (
                  <span
                    className={
                      isExpired
                        ? "shrink-0 text-xs font-medium text-destructive"
                        : "shrink-0 text-xs text-muted-foreground"
                    }
                  >
                    {isExpired ? gt("Expired") : remainingLabel}
                  </span>
                ) : null}
              </div>
              <Input
                ref={inputRef}
                autoComplete="current-password"
                disabled={isResponding || isExpired}
                name="ssh-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
            {visibleResponseError ? (
              <p className="text-sm text-destructive">{visibleResponseError}</p>
            ) : (
              <p className="text-sm text-muted-foreground">
                <T>
                  SSH keys may replace a password, but your server can still require a verification
                  code.
                </T>
              </p>
            )}
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button disabled={isResponding} type="button" variant="outline" onClick={cancelPrompt}>
            {isExpired ? gt("Dismiss") : gt("Cancel")}
          </Button>
          <Button disabled={isResponding || isExpired} form={formId} type="submit">
            <T>Continue</T>
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
