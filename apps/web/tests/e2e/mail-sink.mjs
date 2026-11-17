#!/usr/bin/env node
/**
 * A throw-away SMTP sink and its HTTP inbox, for the branding journeys.
 *
 * `playwright.config.ts` starts this once per run and points the API's
 * `SMTP_URL` at it. Every notification the node sends therefore arrives here
 * as the message a real SMTP server would receive — the branded
 * `multipart/alternative` body included — instead of disappearing into the
 * API's in-process outbox, which the test process cannot read.
 *
 * It is deliberately small and permissive: plain SMTP (no TLS, no auth), one
 * mailbox shared by every journey. `GET /messages?to=<address>` returns the
 * captured messages as JSON, `DELETE /messages` empties the mailbox and
 * `GET /health` is the readiness probe the Playwright config waits on.
 *
 * Not part of the product; nothing here ships.
 */

import http from "node:http";
import net from "node:net";

const SMTP_PORT = Number(process.env.E2E_SMTP_PORT ?? 8125);
const HTTP_PORT = Number(process.env.E2E_SMTP_HTTP_PORT ?? 8126);

/** Enough for a run's consent requests and verification mails; bounded like the API outbox. */
const MAX_MESSAGES = 200;
const messages = [];

/** Extract `<address>` from `MAIL FROM:<address>` / `RCPT TO:<address>`. */
function addressOf(line, command) {
  const match = new RegExp(`^${command}\\s*:\\s*<([^>]*)>`, "i").exec(line);
  return match ? match[1] : "";
}

/** Un-stuff a DATA block: a line whose first character was doubled means a literal dot. */
function unstuff(data) {
  return data
    .split("\r\n")
    .map((line) => (line.startsWith("..") ? line.slice(1) : line))
    .join("\r\n");
}

function record(envelope, data) {
  messages.push({
    from: envelope.from,
    to: envelope.to.slice(),
    // The message as SMTP carried it: CRLF line endings, headers then body.
    raw: `${data}\r\n`,
    receivedAt: new Date().toISOString(),
  });
  if (messages.length > MAX_MESSAGES) {
    messages.shift();
  }
}

const smtp = net.createServer((socket) => {
  let buffer = "";
  let inData = false;
  let envelope = { from: "", to: [] };

  socket.setEncoding("utf8");
  socket.write("220 scholium-e2e ESMTP\r\n");

  socket.on("data", (chunk) => {
    buffer += chunk;

    for (;;) {
      if (inData) {
        // The end of DATA is the first CRLF-dot-CRLF after the headers.
        const end = buffer.indexOf("\r\n.\r\n");
        if (end === -1) {
          return;
        }
        const data = unstuff(buffer.slice(0, end));
        buffer = buffer.slice(end + "\r\n.\r\n".length);
        record(envelope, data);
        envelope = { from: "", to: [] };
        inData = false;
        socket.write("250 2.0.0 Ok: queued\r\n");
        continue;
      }

      const newline = buffer.indexOf("\r\n");
      if (newline === -1) {
        return;
      }
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 2);
      const upper = line.toUpperCase();

      if (upper.startsWith("EHLO")) {
        // No SIZE: smtplib then sends a bare MAIL FROM, which this sink reads.
        socket.write("250-scholium-e2e\r\n250-8BITMIME\r\n250 OK\r\n");
      } else if (upper.startsWith("HELO")) {
        socket.write("250 scholium-e2e\r\n");
      } else if (upper.startsWith("MAIL FROM:")) {
        envelope.from = addressOf(line, "MAIL FROM");
        socket.write("250 2.1.0 Ok\r\n");
      } else if (upper.startsWith("RCPT TO:")) {
        envelope.to.push(addressOf(line, "RCPT TO"));
        socket.write("250 2.1.5 Ok\r\n");
      } else if (upper === "DATA") {
        inData = true;
        socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
      } else if (upper === "RSET") {
        envelope = { from: "", to: [] };
        socket.write("250 2.0.0 Ok\r\n");
      } else if (upper === "NOOP") {
        socket.write("250 2.0.0 Ok\r\n");
      } else if (upper === "QUIT") {
        socket.write("221 2.0.0 Bye\r\n");
        socket.end();
        return;
      } else {
        socket.write("250 2.0.0 Ok\r\n");
      }
    }
  });

  socket.on("error", () => {
    // A client that hangs up mid-command costs nothing.
  });
});

const inbox = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${HTTP_PORT}`);

  if (request.method === "GET" && url.pathname === "/health") {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
    return;
  }

  if (url.pathname === "/messages" && request.method === "GET") {
    const to = url.searchParams.get("to");
    const captured =
      to === null
        ? messages
        : messages.filter((message) =>
            message.to.some((address) => address.toLowerCase() === to.toLowerCase()),
          );
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(captured));
    return;
  }

  if (url.pathname === "/messages" && request.method === "DELETE") {
    messages.length = 0;
    response.writeHead(204);
    response.end();
    return;
  }

  response.writeHead(404, { "content-type": "text/plain" });
  response.end("not found");
});

smtp.listen(SMTP_PORT, "127.0.0.1");
inbox.listen(HTTP_PORT, "127.0.0.1");

function shutdown() {
  smtp.close();
  inbox.close(() => process.exit(0));
  // One hung connection must not keep the run alive.
  setTimeout(() => process.exit(0), 2_000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
