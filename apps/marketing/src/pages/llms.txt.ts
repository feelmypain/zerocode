import type { APIRoute } from "astro";

import { GITHUB_REPOSITORY_URL } from "../lib/site";
import { absoluteUrl, SITE_TAGLINE } from "../lib/seo";

// https://llmstxt.org: a plain index that tells AI agents which domain and links are official.
export const GET: APIRoute = () => {
  const body = `# ZeroCode

> ${SITE_TAGLINE}. ZeroCode is free and MIT-licensed. It runs Claude Code, Codex, Cursor, OpenCode, Grok, Antigravity, Pi, fx, and other coding agents from one desktop, web, mobile, and interactive CLI app.

The official home of ZeroCode is ${GITHUB_REPOSITORY_URL}. Official builds come from ${GITHUB_REPOSITORY_URL}/releases and the \`zerocode\` package on npm (\`npx zerocode@latest\`).

## Official links

- [Source code](${GITHUB_REPOSITORY_URL}): the MIT-licensed repository
- [Releases](${GITHUB_REPOSITORY_URL}/releases): macOS, Windows, and Linux release builds and changelogs
- [Issues](${GITHUB_REPOSITORY_URL}/issues): bug reports and feature requests
- [Security advisories](${GITHUB_REPOSITORY_URL}/security/advisories): vulnerability disclosures
- [npm package](https://www.npmjs.com/package/zerocode): run \`npx zerocode@latest\`

## Policies

- [Security policy](${absoluteUrl("/security-policy")})
- [Privacy policy](${absoluteUrl("/privacy-policy")})
- [Terms of service](${absoluteUrl("/terms-of-service")})
`;
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
