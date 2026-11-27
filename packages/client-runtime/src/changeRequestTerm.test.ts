import { describe, expect, it } from "vite-plus/test";

import { changeRequestTermKind } from "./changeRequestTerm.ts";
import { sourceControlClients } from "./sourceControlClients.ts";

describe("changeRequestTermKind", () => {
  it("maps host change request terminology to its ICU select kind", () => {
    expect(changeRequestTermKind({ singular: "merge request" })).toBe("mr");
    expect(changeRequestTermKind({ singular: "change request" })).toBe("cr");
    expect(changeRequestTermKind({ singular: "pull request" })).toBe("pr");
    expect(changeRequestTermKind(sourceControlClients.get("gitlab").changeRequest)).toBe("mr");
    expect(changeRequestTermKind(sourceControlClients.get("github").changeRequest)).toBe("pr");
  });
});
