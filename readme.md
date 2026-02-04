# TotSM Cloudflare Relay

A high-performance WebSocket relay service built on Cloudflare Workers for managing real-time communication between game servers and multiple clients. This project serves as the MQP (Major Qualifying Project) relay infrastructure for the Total Strength Match (TotSM) platform.

## Overview

The TotSM Cloudflare Relay is a distributed relay system that:
- **Creates dynamic lobbies** - Generates unique lobby codes for game sessions
- **Manages WebSocket connections** - Handles server and client WebSocket connections simultaneously
- **Relays real-time messages** - Forwards messages between game servers and multiple connected clients
- **Scales seamlessly** - Uses Cloudflare Durable Objects for stateful, globally distributed infrastructure

## Architecture

### Core Components

#### RequestWorker
Handles HTTP routing and initial connection requests:
- `/create` - Creates a new lobby and generates a unique lobby code
- `/join/:id` - Joins an existing lobby using its code

#### LobbyDO (Durable Object)
Manages a single lobby instance with:
- **Server connection** - One game server per lobby
- **Client connections** - Multiple clients connected to a single server
- **Message relay** - Routes messages between server and clients
- **Connection lifecycle** - Handles connection/disconnection events

#### CodeGeneratorDO (Durable Object)
Generates unique, collision-resistant lobby codes for new lobbies

#### RelayMessage
Defines the message protocol with:
- **Message types** - DATA, CONNECT, DISCONNECT, CODE
- **Message directions** - Distinguishes between client↔relay and server↔relay communication
- **Serialization/deserialization** - Handles protocol encoding/decoding

## Technology Stack

- **Runtime**: Cloudflare Workers
- **Language**: TypeScript
- **Routing**: itty-router v5.0.22
- **Hosting**: Cloudflare Durable Objects
- **Protocol**: WebSocket with custom relay message format

## Getting Started

### Prerequisites
- Node.js and npm
- Wrangler CLI (`npm install -g wrangler`)
- Cloudflare account

### Installation

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```

### Development

Start the local development server:
```bash
npm run dev
```

Generate TypeScript bindings for Cloudflare Workers:
```bash
npm run cf-typegen
```

### Deployment

Deploy to Cloudflare Workers:
```bash
npm run deploy
```

## API Endpoints

### Create Lobby
```
GET /create
```
Creates a new lobby and returns a WebSocket connection point.

**Response**: WebSocket upgrade response with lobby code

### Join Lobby
```
GET /join/:id
```
Joins an existing lobby with the given code.

**Parameters**:
- `id` - The lobby code returned from `/create`

**Response**: WebSocket upgrade response if lobby exists, 404 if not found

## Message Protocol

Messages flow through the relay with specified directions:
- `CLIENT_TO_RELAY` - Client to relay service
- `RELAY_TO_CLIENT` - Relay to client
- `SERVER_TO_RELAY` - Server to relay service
- `RELAY_TO_SERVER` - Relay to server

Supported message types:
- `DATA` - General data messages
- `CONNECT` - Connection initialization
- `DISCONNECT` - Connection termination
- `CODE` - Lobby code transmission

## Configuration

Key configuration in `wrangler.jsonc`:
- **Compatibility Date**: `2026-01-31`
- **Durable Objects**:
  - `LobbyDO` - Manages individual lobbies
  - `CodeGeneratorDO` - Generates unique codes
- **Smart Placement**: Enabled for optimal performance

## Project Structure

```
worker-configuration.d.ts  # Type definitions
src/
├── index.ts              # Main entry point
├── RequestWorker.ts      # HTTP request handler and router
├── LobbyDO.ts           # Lobby Durable Object implementation
├── CodeGeneratorDO.ts   # Code generation Durable Object
└── RelayMessage.ts      # Message protocol definitions
```

## Scripts

- `npm run dev` - Start development server
- `npm run start` - Alias for dev
- `npm run deploy` - Deploy to Cloudflare Workers
- `npm run cf-typegen` - Generate Cloudflare type definitions

## Notes

- Smart Placement is enabled to automatically optimize Durable Object placement
- The relay supports multiple clients per server connection
- Lobby codes are generated to be collision-resistant
- All connections use WebSocket protocol for real-time communication
