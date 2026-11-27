import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Covers EventSink.write's unlessNativeThreadOwned lookup without scanning provider threads.
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_provider_threads_native_id_idx
    ON orchestration_v2_projection_provider_threads(
      driver,
      provider_instance_id,
      json_extract(payload_json, '$.nativeThreadRef.nativeId')
    )
    WHERE json_valid(payload_json)
  `;

  // Covers ProjectionStore's latestProviderTurnUsageOnly lookup in descending ISO-8601 UTC order.
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_provider_turns_token_usage_idx
    ON orchestration_v2_projection_provider_turns(
      thread_id,
      json_extract(payload_json, '$.tokenUsage.updatedAt') DESC,
      provider_thread_id ASC,
      ordinal ASC
    )
    WHERE json_valid(payload_json)
      AND json_extract(payload_json, '$.tokenUsage.updatedAt') IS NOT NULL
  `;
});
