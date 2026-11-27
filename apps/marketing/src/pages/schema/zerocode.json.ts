import type { APIRoute } from "astro";

import { buildZeroCodeProjectFileJsonSchema } from "@zerocode/shared/zeroCodeProjectFile";

export const GET: APIRoute = () =>
  new Response(`${JSON.stringify(buildZeroCodeProjectFileJsonSchema(), null, 2)}\n`, {
    headers: { "Content-Type": "application/json" },
  });
