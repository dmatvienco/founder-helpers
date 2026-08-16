// Fake claude CLI: expired/unrefreshable OAuth session (#21). Shape matches
// the real incident log: the structured "error" field rides on the
// *assistant* line, not the final result line.
console.log(
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "Failed to authenticate: OAuth session expired and could not be refreshed" }] },
    error: "authentication_failed",
    is_api_error_message: true,
  }),
);
console.log(
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: true,
    result: "Failed to authenticate: OAuth session expired and could not be refreshed",
  }),
);
process.exit(1);
