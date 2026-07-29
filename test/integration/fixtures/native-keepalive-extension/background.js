/**
 * DEV-261 native-messaging keepalive probe.
 *
 * The native host waits longer than Firefox's MV3 idle timeout before sending
 * its second message. If this event page is still alive, both replies carry
 * the same in-memory token and startup timestamp. The host writes the result.
 */

"use strict";

const startedAt = Date.now();
const token = crypto.randomUUID();
const port = browser.runtime.connectNative(
  "com.zen_agent.dev261_keepalive_probe",
);

port.onMessage.addListener((message) => {
  if (message?.phase === "ready" || message?.phase === "after-idle") {
    port.postMessage({
      phase: `${message.phase}-ack`,
      startedAt,
      token,
      receivedAt: Date.now(),
    });
  }
});
