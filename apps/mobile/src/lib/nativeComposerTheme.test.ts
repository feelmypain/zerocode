import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_MOBILE_THEME_ID, getMobileThemeVariables } from "./mobileTheme";
import { createNativeComposerTheme } from "./nativeComposerTheme";

describe("native composer colors", () => {
  it("flattens Material You alpha colors over the composer rather than falling back to defaults", () => {
    const theme = createNativeComposerTheme({
      ...getMobileThemeVariables(DEFAULT_MOBILE_THEME_ID, "light"),
      "--color-screen": "#ffffffff",
      "--color-composer-surface": "#ffffffff",
      "--color-placeholder": "#0000009e",
    });
    expect(theme.placeholder).toBe("#616161");
  });
});
