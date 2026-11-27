import { matchers, routes, type Transform, type VercelConfig } from "@vercel/config/v1";

const HOSTED_WEB_CHANNEL_COOKIE = "zerocode_web_channel";
const CLEAN_CHANNEL_QUERY_TRANSFORMS = [
  {
    type: "request.query",
    op: "delete",
    target: { key: "channel" },
  },
] satisfies Transform[];

function channelCookie(channel: "latest" | "nightly"): string {
  return [
    `${HOSTED_WEB_CHANNEL_COOKIE}=${channel}`,
    "Path=/",
    "Max-Age=31536000",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}

export const config: VercelConfig = {
  buildCommand:
    'vp run --filter @zerocode/web build && node ../../scripts/apply-web-brand-assets.ts --channel "${VITE_HOSTED_APP_CHANNEL:-latest}"',
  git: {
    deploymentEnabled: false,
  },
  installCommand:
    "npm install -g vite-plus && vp install --ignore-scripts --filter '@zerocode/scripts...' --filter '@zerocode/web...'",
  routes: [
    {
      src: "/__zerocode/channel",
      has: [matchers.query("channel", "nightly")],
      transforms: CLEAN_CHANNEL_QUERY_TRANSFORMS,
      headers: {
        Location: "/",
        "Set-Cookie": channelCookie("nightly"),
      },
      status: 302,
    },
    {
      src: "/__zerocode/channel",
      transforms: CLEAN_CHANNEL_QUERY_TRANSFORMS,
      headers: {
        Location: "/",
        "Set-Cookie": channelCookie("latest"),
      },
      status: 302,
    },
  ],
  rewrites: [
    // Apple fetches it without an extension; the .json file is served as application/json.
    routes.rewrite(
      "/.well-known/apple-app-site-association",
      "/.well-known/apple-app-site-association.json",
    ),
    routes.rewrite("/(.*)", "/index.html"),
  ],
};
