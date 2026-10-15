import { Events, RESTEvents, type Client } from "discord.js";

type ConnectionState = {
  phase: string;
  updatedAt: string;
  gatewayHttpStatus?: number;
  retryAt?: string;
};

const states = new WeakMap<Client, ConnectionState>();

export function getDiscordConnectionStatus(client: Client): ConnectionState {
  const state = states.get(client) ?? { phase: "starting", updatedAt: new Date().toISOString() };
  return { ...state, phase: client.isReady() ? "ready" : state.phase };
}

export function trackDiscordConnection(client: Client): void {
  const state: ConnectionState = { phase: "gateway-request", updatedAt: new Date().toISOString() };
  states.set(client, state);
  const update = (phase: string) => {
    state.phase = phase;
    state.updatedAt = new Date().toISOString();
    if (phase !== "rate-limited") delete state.retryAt;
    console.log("Discord connection state", { ...state });
  };
  update("gateway-request");

  // Map known debug events to fixed labels. Never log raw debug messages:
  // the library also emits token fragments and session information there.
  client.on(Events.Debug, (message) => {
    if (message.includes("Fetched Gateway Information")) update("gateway-discovered");
    else if (message.includes("[WS =>") && message.includes("Connecting to wss://")) update("websocket-connecting");
    else if (message.includes("Waiting for event hello")) update("websocket-hello");
    else if (message.includes("Waiting for identify throttle")) update("identify-wait");
    else if (message.includes("Waiting for event ready")) update("gateway-ready-wait");
  });

  client.rest.on(RESTEvents.Response, (request, response) => {
    if (request.path !== "/gateway/bot") return;
    state.gatewayHttpStatus = response.status;
    console.log("Discord gateway HTTP response", { status: response.status });
  });
  client.rest.on(RESTEvents.RateLimited, (info) => {
    if (info.route !== "/gateway/bot") return;
    state.retryAt = new Date(Date.now() + info.retryAfter).toISOString();
    update("rate-limited");
  });
  client.on(Events.ShardReady, () => update("guild-ready-wait"));
  client.on(Events.ClientReady, () => update("ready"));
  client.on(Events.ShardDisconnect, () => update("disconnected"));
  client.on(Events.ShardReconnecting, () => update("reconnecting"));
  client.on(Events.ShardResume, () => update("resumed"));
  client.on(Events.Error, () => update("client-error"));
  client.on(Events.ShardError, () => update("websocket-error"));
}
