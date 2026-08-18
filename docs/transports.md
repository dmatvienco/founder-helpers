# Transports

Telegram ships first; the rest of the system is channel-agnostic behind the
`Transport` interface (`src/transport/transport.ts`):

```ts
start(onMessage)   // sequential delivery; rejection = redelivery
stop()
send(text)         // implementation chunks as needed
sendPhoto(path, caption?)
setTyping(on)
startProgress(initialText)  // opens one message for a long run's live progress
updateProgress(text)        // latest short action line; throttled/coalesced into edits
endProgress()
```

Guarantees any implementation must keep:

- **The offset belongs to the transport.** Persist it yourself
  (code-written file), advance it only after the handler resolves.
- **Sequential delivery.** One message at a time; a rejected handler means
  the same message is redelivered later — never lost, never reordered.
- **Self-alerting.** N identical loop errors in a row → tell the founder the
  channel is stuck (once, then rarely) instead of dying silently.
- **No secrets in logs.**

## Security model

The bot only reacts to the single chat id captured during `fh init` pairing
(the chat that sent the first message). Messages from any other chat are
ignored — never processed, never replied to — and logged at `warn` level so
a stray or malicious contact attempt is visible instead of silently dropped.

To add Slack/Discord/etc.: implement the interface, extend the secrets
schema and `createProjectTransport`, and add a pairing step to `fh init`.
Contributions welcome — keep the dependency count at zero (global fetch).
