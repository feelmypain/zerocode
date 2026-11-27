// Static fallback stats so marketing builds work cleanly offline and without external API calls.
export const MARKETING_STATS = {
  githubStars: "0",
  users: "0",
} as const;
