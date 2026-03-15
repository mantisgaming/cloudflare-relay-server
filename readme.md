# TotSM Cloudflare Relay

Cloudflare Worker and Durable Object relay for TotSM real-time sessions. The relay creates short lobby codes, accepts one host server and multiple client peers per lobby, and forwards authenticated WebSocket packets between them.

## Disclaimer

The `demo-site/` implementation and this README were created with AI assistance.

## Overview

This service is responsible for:

- Creating lobby codes for new sessions
- Accepting one server connection per lobby
- Accepting multiple client connections per lobby
- Relaying signed packets between the server and connected clients
- Supporting server reconnection with a reconnect code
- Enforcing request and message rate limits with token buckets

## Architecture

### Request flow

The entry worker routes requests under the configured base route, which defaults to `/relay`.

- `GET /relay/create` creates a lobby and upgrades the caller to the host server WebSocket
- `GET /relay/join/:id` upgrades the caller to a client WebSocket for an active lobby
- `GET /relay/reconnect/:id/:reconnectCode` reconnects the host server to a disconnected lobby

### Durable Objects

- `LobbyDO` manages a single lobby, including the host server socket, client peer sockets, relay state, and per-lobby rate limiting
- `CodeGeneratorDO` generates short alphabetic lobby codes
- `IPRateLimiterDO` enforces request limits per IP address and request type
- `GlobalRateLimiterDO` enforces shared request limits across the service

### Lobby behavior

Each lobby has:

- Exactly one server connection at a time
- Up to `MAXIMUM_LOBBY_CONNECTIONS` client peers
- A persisted lobby record in D1 with `code`, `reconnect_code`, `connected`, and `last_updated`
- Automatic ping, timeout, idle cleanup, and scheduled stale-lobby cleanup

## Project Structure

```text
.
|-- package.json                  # NPM scripts and dependencies
|-- readme.md                     # Project documentation
|-- RELAY_D1_schema.sql           # D1 schema, banned codes, and triggers
|-- tsconfig.json                 # TypeScript configuration
|-- worker-configuration.d.ts     # Cloudflare Worker environment typings
|-- wrangler.jsonc                # Worker, DO, D1, routes, and env config
|-- demo-site/
|   |-- index.html                # Browser demo UI for relay flows
|   |-- app.js                    # Demo websocket logic and packet signing
|   `-- styles.css                # Demo styling
`-- src/
    |-- Bucket.ts                 # Token-bucket utilities
    |-- CodeGeneratorDO.ts        # Lobby code generator durable object
    |-- GlobalRateLimiterDO.ts    # Shared request rate limiter durable object
    |-- index.ts                  # Worker entrypoint and DO exports
    |-- IPRateLimiterDO.ts        # Per-IP request rate limiter durable object
    |-- LobbyDO.ts                # Lobby lifecycle and packet relay logic
    |-- RelayMessage.ts           # Packet and payload type definitions
    `-- RequestWorker.ts          # HTTP routing and scheduled tasks
```

## Setup

### Prerequisites

- Node.js
- npm
- Wrangler CLI access through `npx` or a global install
- A Cloudflare account with Workers, Durable Objects, and D1 enabled

### Install

```bash
npm install
```

### Useful scripts

- `npm run predev` runs automatically before `npm run dev` and resets the local D1 schema
- `npm run dev` starts the Worker locally with scheduled events enabled and the `development` environment (after running `predev`)
- `npm run demo-site` serves `demo-site/` on `http://127.0.0.1:8080`
- `npm run start` starts Wrangler dev without the explicit development env shortcut
- `npm run deploy` deploys the Worker
- `npm run cf-typegen` regenerates Cloudflare environment typings
- `npm run reset-local-db` manually recreates the local D1 schema from `RELAY_D1_schema.sql`

## Demo Site

The `demo-site/` folder contains a browser-based protocol console for manually testing relay behavior.

It supports:

- Creating a lobby as the server
- Joining a lobby as a client
- Server reconnect using reconnect keys
- Sending `dat` payloads from both sides
- Auto-accepting new peers from the server view
- Live event logging and optional incoming digest verification

### Run the demo locally

1. Start the relay Worker:

```bash
npm run dev
```

2. Ensure the Worker has a value for `HMAC_APPLICATION_SECRET` (required for signed packets):

```bash
npx wrangler secret put HMAC_APPLICATION_SECRET -e development
```

3. Serve the demo site from a second terminal:

```bash
npm run demo-site
```

4. Open `http://127.0.0.1:8080` and configure:

- Relay URL: `http://127.0.0.1:8787/relay`
- Application secret: the same hex secret you configured for `HMAC_APPLICATION_SECRET`

### Quick validation flow

1. Click **Create lobby as server**.
2. Click **Join as client** (using the same lobby code).
3. Send a `dat` payload from client and verify it appears on server.
4. Send a `dat` payload from server and verify it appears on client.
5. Disconnect server, click **Reconnect server**, and verify the lobby continues.

## HTTP API

All routes are relative to `BASE_ROUTE`, which is `/relay` by default.

### Create lobby

```http
GET /relay/create
Upgrade: websocket
```

Behavior:

- Generates a new lobby code through `CodeGeneratorDO`
- Creates the lobby record in D1
- Upgrades the caller to the server WebSocket
- Immediately sends an `inf` payload to the server containing:
  - `code`: the lobby code
  - `key`: the server session key
  - `reconnectKey`: the current reconnect code

### Join lobby

```http
GET /relay/join/:id
Upgrade: websocket
```

Behavior:

- Only succeeds if the lobby exists and is currently connected to a server
- Allocates a numeric peer ID for the client
- Notifies the server with a `con` payload containing that peer ID
- The client does not receive its session `key` until the server explicitly accepts the connection by sending its own `con` payload back to the relay

### Reconnect server

```http
GET /relay/reconnect/:id/:reconnectCode
Upgrade: websocket
```

Behavior:

- Only succeeds if the lobby exists, is currently disconnected, and the reconnect code matches
- Replaces the reconnect code with a new value
- Upgrades the caller to the server WebSocket
- Sends an `inf` payload to the server followed by one `con` payload for each already-connected client peer

## WebSocket Packet Format

Every non-ping WebSocket message is a JSON array of relay packets:

```json
[
  {
    "pld": "{\"msg\":\"dat\",\"dat\":{\"hello\":\"world\"}}",
    "dgs": "1a2b3c4d"
  }
]
```

Each packet has this shape:

```ts
type RelayMessage = {
  pld: string;
  dgs: string;
};
```

- `pld` is a JSON string containing the payload object
- `dgs` is an 8-character hex digest derived from SHA-256 over the payload plus the application secret and per-socket key

The relay also uses plain-text heartbeat messages:

- Incoming `ping` receives `pong`
- Incoming `pong` is ignored
- The scheduled job sends `ping` to active sockets

## Payload Format

Payloads are serialized inside `pld`. The `msg` field determines the payload type.

### Message types

- `dat` data message
- `con` connection notification or acceptance
- `dsc` disconnect notification or server-initiated kick
- `inf` relay-issued connection info
- `unknown` placeholder type defined in code but not used in normal flow

### Direction rules

The fields present on a payload depend on who sends it.

#### Server to relay

```json
{ "msg": "dat", "dat": { "state": "update" }, "dst": [0, 2, 3] }
{ "msg": "con", "pid": 4 }
{ "msg": "dsc", "pid": 2 }
```

- `dat` forwards arbitrary `dat` content to the listed destination peer IDs in `dst`
- `con` accepts a pending client connection; once accepted, the relay sends that client its `inf` message with its session key
- `dsc` disconnects the specified client peer

#### Relay to server

```json
{ "msg": "inf", "code": "ABCD", "key": "...", "reconnectKey": "..." }
{ "msg": "con", "pid": 4 }
{ "msg": "dsc", "pid": 2 }
{ "msg": "dat", "src": 1, "dat": { "input": "jump" } }
```

- `inf` is sent when the server first creates or reconnects to a lobby
- `con` notifies the server that a client has connected and is waiting to be accepted
- `dsc` notifies the server that a client disconnected
- `dat` forwards a client payload and includes the sender peer ID in `src`

#### Client to relay

```json
{ "msg": "dat", "dat": { "input": "move-left" } }
```

- Clients are only expected to send `dat`

#### Relay to client

```json
{ "msg": "inf", "key": "..." }
{ "msg": "dat", "dat": { "snapshot": {} } }
```

- `inf` is sent only after the server accepts the client with a `con` message
- `inf` includes the client session `key`
- `dat` forwards opaque server payloads to the client

## Connection Sequence

### Server creates a lobby

1. Server opens `GET /relay/create` as a WebSocket upgrade.
2. Relay creates a lobby code and D1 row.
3. Relay sends the server an `inf` payload with `code`, `key`, and `reconnectKey`.

### Client joins a lobby

1. Client opens `GET /relay/join/:id` as a WebSocket upgrade.
2. Relay assigns a peer ID.
3. Relay sends `con` with `pid` to the server.
4. Server accepts by sending `con` with the same `pid` back to the relay.
5. Relay sends `inf` with the client key to that client.

### Server reconnects

1. Server opens `GET /relay/reconnect/:id/:reconnectCode` as a WebSocket upgrade.
2. Relay validates the reconnect code and issues a new one.
3. Relay sends `inf` with the new session `key`, lobby `code`, and replacement `reconnectKey`.
4. Relay replays `con` for all currently connected client peers.

## Limits And Cleanup

- Request entrypoints are guarded by both global and per-IP rate limiters
- Individual lobby operations also use per-lobby token buckets
- Server and client sockets have independent message rate limits
- Binary frames are rejected
- Oversized messages are rejected when they exceed `MAXIMUM_MESSAGE_SIZE` kilobytes
- Connections are closed after roughly 15 seconds without a valid message or ping response
- Idle sockets are closed after roughly 30 minutes
- A scheduled task cleans up stale lobbies and sends heartbeat pings

## Configuration Notes

Important values are defined in `wrangler.jsonc`:

- `BASE_ROUTE` defaults to `/relay`
- `CODE_LENGTH` defaults to `4`
- `MAXIMUM_LOBBY_CONNECTIONS` defaults to `12`
- `MAXIMUM_MESSAGE_SIZE` defaults to `4` KB
- Smart placement is enabled
- Production and development environments both bind the same Durable Object classes and D1 database interface

The worker requires `HMAC_APPLICATION_SECRET` to be present in the environment. Without it, requests fail before routing.
