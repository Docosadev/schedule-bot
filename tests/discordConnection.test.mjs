import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Events, RESTEvents } from "discord.js";
import { trackDiscordConnection, getDiscordConnectionStatus } from "../dist/discordConnection.js";

function clientFixture() {
  const client = new EventEmitter();
  client.rest = new EventEmitter();
  client.isReady = () => false;
  trackDiscordConnection(client);
  return client;
}

test("connection diagnostics distinguish HTTP rate limit from WebSocket readiness", () => {
  const client = clientFixture();
  client.rest.emit(RESTEvents.Response, { path: "/gateway/bot" }, { status: 429 });
  client.rest.emit(RESTEvents.RateLimited, { route: "/gateway/bot", retryAfter: 60_000 });
  let state = getDiscordConnectionStatus(client);
  assert.equal(state.phase, "rate-limited");
  assert.equal(state.gatewayHttpStatus, 429);
  assert.ok(Date.parse(state.retryAt) > Date.now());
  client.rest.emit(RESTEvents.Response, { path: "/gateway/bot" }, { status: 200 });
  client.emit(Events.Debug, "[WS => Manager] Fetched Gateway Information");
  state = getDiscordConnectionStatus(client);
  assert.equal(state.phase, "gateway-discovered");
  assert.equal(state.retryAt, undefined);
  assert.equal(state.gatewayHttpStatus, 200);
  client.isReady = () => true;
  assert.equal(getDiscordConnectionStatus(client).phase, "ready");
});

test("diagnostics do not expose token fragments or unrelated API routes", () => {
  const client = clientFixture();
  client.emit(Events.Debug, "Provided token: secret-token-fragment");
  client.rest.emit(RESTEvents.Response, { path: "/interactions/id/secret-token/callback" }, { status: 400 });
  client.rest.emit(RESTEvents.RateLimited, { route: "/channels/id/messages", retryAfter: 60_000 });
  const state = getDiscordConnectionStatus(client);
  assert.equal(state.phase, "gateway-request");
  assert.equal(state.gatewayHttpStatus, undefined);
  assert.equal(JSON.stringify(state).includes("secret"), false);
});
