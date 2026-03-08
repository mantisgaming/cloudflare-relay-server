import { DurableObject } from "cloudflare:workers";
import { RelayMessage, RelayMessagePayload } from "./RelayMessage";

interface LobbyState {
	code: string | null;
	nextPeer: number;
	lastCleanup: number;
}

type WebsocketMetadata = {
	/** HMAC Key for this websocket */
	key: string;
	/** The last time a valid message was received */
	lastMessageTime: number;
	/** The last time any message or ping was received */
	lastActiveTime: number;
	/** Whether or not the websocket is a server host */
	isServer: boolean;
} & (
		{
			isServer: true;
		} | {

			isServer: false,
			/** Peer ID number for this websocket */
			peerID: number
		}
	);

function createRandomKey(length: number): string {
	const buffer = new Uint8Array(length);
	crypto.getRandomValues(buffer);
	return toHexString(buffer);
}

async function createMessageDigest(payload: any, ...keys: string[]): Promise<string> {
	const binaryKeys = keys.map(fromHexString);
	const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));

	const data = new Uint8Array(payloadBytes.length + binaryKeys.reduce((size, key) => size + key.length, 0));

	data.set(payloadBytes, 0);
	binaryKeys.reduce((offset, key) => {
		data.set(key, offset);
		return offset + key.length;
	}, data.length);

	return toHexString(new Uint8Array(await crypto.subtle.digest("SHA-256", data)));
}

async function verifyMessageDigest(message: RelayMessage, ...keys: string[]): Promise<boolean> {
	const calculatedDigest = await createMessageDigest(message.pld, ...keys);
	const receivedDigest = message.dgs;
	return calculatedDigest === receivedDigest;
}

function toHexString(data: Uint8Array): string {
	return data.reduce((str, byte) => str + byte.toString(16).padStart(2, '0'), '');
}

function fromHexString(hexString: string): Uint8Array {
	// Ensure the string has an even number of characters
	if (hexString.length % 2 !== 0) {
		throw new Error("Hex string must have an even number of characters");
	}

	const matches = hexString.match(/.{1,2}/g);

	if (matches === null) {
		throw new Error("Hex string failed to parse");
	}

	return new Uint8Array(matches.map((byte) => parseInt(byte, 16)));
};

// Durable Object for relaying a WebSocket lobby between a server and multiple clients
export class LobbyDO extends DurableObject<Env> {
	private state: LobbyState = {
		code: null,
		nextPeer: 0,
		lastCleanup: Date.now()
	}

	private server: WebSocket | null = null;
	private peers: Map<number, WebSocket> = new Map();

	// Constructor
	constructor(ctx: DurableObjectState<{}>, env: Env) {
		super(ctx, env);
		this.loadState();
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));

		for (const ws of ctx.getWebSockets()) {
			const data = ws.deserializeAttachment() as WebsocketMetadata;
			if (data === undefined) {
				ws.close(1008, "Missing WebSocket attachment");
				return;
			}

			if (data.isServer) {
				if (this.server != null) {
					console.warn("Multiple websockets marked as server");
					ws.close(1008, "Socket appears to be duplicate server");
				} else {
					this.server = ws;
				}
			} else {
				this.peers.set(data.peerID, ws);
			}
		}

		// Update database with lobby connection state
		env.RELAY_D1.prepare(`
			UPDATE lobbies
			SET connected = ?
			WHERE code = ?
		`).bind(this.server === null ? 0 : 1, this.state.code).run();
	}

	/** Save the state of the durable object */
	private saveState(): void {
		this.ctx.storage.put(this.state as Record<string, any>)
	}

	/** Load the state of the durable object */
	private async loadState(): Promise<void> {
		Object.assign(this.state, await this.ctx.storage.get(Object.keys(this.state)));
	}

	/** Remove any websockets that have not responded recently */
	private async cleanup(): Promise<void> {
		if (Date.now() - this.state.lastCleanup < 1000 * 1)
			return;

		this.state.lastCleanup = Date.now();
		this.saveState();

		for (const socket of this.ctx.getWebSockets()) {
			const socketData = socket.deserializeAttachment() as WebsocketMetadata;
			const lastAction = socketData.lastActiveTime;
			const lastMessage = Math.max(
				socketData.lastMessageTime,
				this.ctx.getWebSocketAutoResponseTimestamp(socket)?.getTime() ?? 0
			);

			const now = Date.now();

			if (now - lastMessage > 1000 * 15) {
				socket.close(1000, "Connection Timed Out");
			} else if (now - lastAction > 1000 * 60 * 30) {
				socket.close(1000, "Connection Idle");
			}
		}

		// If the lobby has been removed from the database, it should be reset
		const existingLobby = await this.env.RELAY_D1.prepare("SELECT * FROM lobbies WHERE code = ?").bind(this.state.code).all();
		if (!existingLobby) {
			this.reset();
		}
	}

	/** Reset the durable object */
	reset(): void {
		this.server = null;
		this.peers = new Map();
		this.state = {
			code: null,
			nextPeer: 0,
			lastCleanup: Date.now()
		}

		for (const socket of this.ctx.getWebSockets()) {
			socket.close(1012, "Lobby Reset");
		}

		this.saveState();
	}

	pingRoutine(): void {
		for (const socket of this.ctx.getWebSockets()) {
			socket.send("ping");
		}

		this.cleanup();
	}

	// Handle incoming requests
	async fetch(request: Request): Promise<Response> {
		// TODO: add rate limiter

		// Determine the method from headers
		const method = request.headers.get("Method");
		if (method === "create") {
			// Get the lobby code from headers
			const code = request.headers.get("Lobby-Code");
			if (code == null) {
				return new Response("Missing Lobby-Code header", { status: 400 });
			}
			// Connect the server
			return await this.connectServer(request, code);
		} else if (method === "join") {
			// Connect the client
			return await this.connectClient(request);
		} else if (method === "reconnect") {
			// Reconnect a client
			return await this.reconnectServer(request);
		}

		// Unknown method
		return new Response("Not Found", { status: 404 });
	}

	async connectServer(request: Request, code: string): Promise<Response> {
		// TODO: add rate limiter

		// Require that the request is a WebSocket upgrade
		const upgradeHeader = request.headers.get('Upgrade');
		if (!upgradeHeader || upgradeHeader !== "websocket") {
			return new Response("Expected WebSocket", { status: 426 });
		}

		// Check if a server is already connected
		if (this.server !== null) {
			return new Response("A server is already connected to this lobby", { status: 403 });
		}

		// Save the code
		this.state.code = code;
		this.saveState();

		// Insert the new lobby code into the database
		const insertResult = await this.env.RELAY_D1.prepare("INSERT INTO lobbies (code) VALUES (?)").bind(this.state.code).run();
		if (insertResult.error) {
			return new Response("Database Error", { status: 500 });
		}

		// Create a WebSocket pair
		const { 0: client, 1: server } = new WebSocketPair();

		// Accept the server WebSocket
		this.ctx.acceptWebSocket(server);
		this.server = server;

		// Save data to websocket
		const serverWSData: WebsocketMetadata = {
			isServer: true,
			key: createRandomKey(32),
			lastActiveTime: Date.now(),
			lastMessageTime: Date.now()
		};
		server.serializeAttachment(serverWSData);

		// Send the lobby code to the server
		const infoPayload: RelayMessagePayload.Info<"relay-to-server"> = {
			code: this.state.code,
			key: serverWSData.key,
			msg: "inf"
		};

		// Create packet
		const infoPacket: RelayMessage<RelayMessagePayload.Info<"relay-to-server">> = {
			dgs: await createMessageDigest(infoPayload, this.env.HMAC_APPLICATION_SECRET, serverWSData.key),
			pld: infoPayload
		};

		// Send info to server
		server.send(JSON.stringify(infoPacket));

		// Log success
		console.log(`Relay "${this.state.code}": Server connected to lobby`);

		// Return the client WebSocket
		return new Response(null, { status: 101, webSocket: client });
	}

	async connectClient(request: Request): Promise<Response> {
		// TODO: add rate limiter

		// Check if a server is connected
		if (this.server === null) {
			return new Response("No server connected to this lobby", { status: 404 });
		}

		// Require that the request is a WebSocket upgrade
		const upgradeHeader = request.headers.get('Upgrade');
		if (!upgradeHeader || upgradeHeader !== "websocket") {
			return new Response("Expected WebSocket", { status: 426 });
		}

		// Limit the number of peer connections
		if (this.peers.size >= this.env.MAXIMUM_LOBBY_CONNECTIONS) {
			return new Response("Lobby is full", { status: 423 })
		}

		// Get the next available peer ID
		const id = this.getNextAvailablePeer();

		// Create a WebSocket pair
		const { 0: client, 1: server } = new WebSocketPair();

		// Accept the client WebSocket
		this.ctx.acceptWebSocket(server);
		this.peers.set(id, server);

		// Save data to websocket
		const serverWSData: WebsocketMetadata = {
			isServer: false,
			peerID: id,
			key: createRandomKey(32),
			lastActiveTime: Date.now(),
			lastMessageTime: Date.now()
		};
		server.serializeAttachment(serverWSData);

		console.log(`Relay "${this.state.code}": Client "${id}" connected to lobby`);

		// Inform the server of the new connection
		const infoPayload: RelayMessagePayload.Connect<"relay-to-server"> = {
			msg: "con",
			pid: id
		};

		// Create packet
		const infoPacket: RelayMessage<RelayMessagePayload.Connect<"relay-to-server">> = {
			dgs: await createMessageDigest(infoPayload, this.env.HMAC_APPLICATION_SECRET, serverWSData.key),
			pld: infoPayload
		};

		// Send info to server
		server.send(JSON.stringify(infoPacket));

		// Return the client WebSocket
		return new Response(null, { status: 101, webSocket: client });
	}

	async reconnectServer(request: Request): Promise<Response> {
		// TODO: add rate limiter

		// Get headers
		const upgradeHeader = request.headers.get('Upgrade');
		const reconnectCode = request.headers.get('Reconnect-Code');
		const code = request.headers.get("Lobby-Code");

		// Require that the request is a WebSocket upgrade
		if (!upgradeHeader || upgradeHeader !== "websocket") {
			return new Response("Expected WebSocket", { status: 426 });
		}

		// Make sure a code was sent
		if (code === null) {
			return new Response("Code not provided", { status: 400 });
		}

		// Make sure a reconnect code was sent
		if (reconnectCode === null) {
			return new Response("Reconnect code not provided", { status: 400 });
		}

		// Check if a server is already connected
		if (this.server !== null) {
			return new Response("A server is already connected to this lobby", { status: 403 });
		}

		// Check database for existing lobby
		const existingLobby = await this.env.RELAY_D1.prepare(`
			SELECT * FROM lobbies
			WHERE code = ? AND reconnect_code = ?
		`).bind(code, reconnectCode).first();

		if (!existingLobby) {
			return new Response(`Lobby "${code}" not found or invalid code provided`, { status: 404 });
		}

		if (this.state.code === null) {
			this.state.code = code;
		} else if (this.state.code != code) {
			console.warn(`Lobby tried to reconnect to ${code} but lobby already belongs to ${this.state.code}`);
			return new Response(`Lobby belongs to different code`, { status: 500 });
		}

		// Update database to mark the lobby as connected
		const updateResult = await this.env.RELAY_D1.prepare("UPDATE lobbies SET connected = 1 WHERE code = ?").bind(this.state.code).run();
		if (updateResult.error) {
			return new Response("Database Error", { status: 500 });
		}

		// Create a WebSocket pair
		const { 0: client, 1: server } = new WebSocketPair();

		// Accept the server WebSocket
		this.ctx.acceptWebSocket(server);
		this.server = server;

		// Save data to websocket
		const serverWSData: WebsocketMetadata = {
			isServer: true,
			key: createRandomKey(32),
			lastActiveTime: Date.now(),
			lastMessageTime: Date.now()
		};
		server.serializeAttachment(serverWSData);

		// Send the lobby code to the server
		const infoPayload: RelayMessagePayload.Info<"relay-to-server"> = {
			code: this.state.code,
			key: serverWSData.key,
			msg: "inf"
		};

		// Create Packet
		const infoPacket: RelayMessage<RelayMessagePayload.Info<"relay-to-server">> = {
			dgs: await createMessageDigest(infoPayload, this.env.HMAC_APPLICATION_SECRET, serverWSData.key),
			pld: infoPayload
		};

		// Send info to server
		server.send(JSON.stringify(infoPacket));

		// Log success
		console.log(`Relay "${this.state.code}": Server connected to lobby`);

		// Return the client WebSocket
		return new Response(null, { status: 101, webSocket: client });
	}

	/** Get the next available peer ID */
	private getNextAvailablePeer(): number {
		const peer = this.state.nextPeer++;
		this.saveState();
		return peer;
	}

	/** Any websocket message will call this function */
	webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
		// Get the websocket data and update its last active time
		const wsData = ws.deserializeAttachment() as WebsocketMetadata;
		wsData.lastActiveTime = Date.now();
		ws.serializeAttachment(wsData);

		// Run cleanup routine
		this.cleanup();

		// Reject binary data
		if (typeof message == "object") {
			ws.close(1007, "Received Binary Data");
			return;
		}

		// Respond to ping message
		if (message === "ping") {
			ws.send("pong");
			return;
		}

		// Ignore pong message
		if (message === "pong") {
			return;
		}

		// Parse data
		const messageData = JSON.parse(message) as RelayMessage;

		// Check hmac
		if (!verifyMessageDigest(messageData, this.env.HMAC_APPLICATION_SECRET, wsData.key)) {
			ws.close(1007, "HMAC Digest Did Not Match");
			return;
		}

		// Call corresponding event handler
		if (wsData.isServer) {
			this.onServerMessage(ws, wsData, messageData);
		} else {
			this.onClientMessage(ws, wsData, messageData);
		}
	}

	webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): void {
		// Get the websocket data
		const wsData = ws.deserializeAttachment() as WebsocketMetadata;

		// Run cleanup routine
		this.cleanup();

		ws.close(code, reason);

		// Call corresponding event handler
		if (wsData.isServer) {
			console.log(`Relay "${this.state.code}": Server websocket closed: ${reason}`);
			this.onServerClose();
		} else {
			console.log(`Relay "${this.state.code}": Client ${wsData.peerID} websocket closed: ${reason}`);
			this.onClientClose(wsData.peerID);
		}
	}

	webSocketError(ws: WebSocket, error: unknown): void {
		// Get the websocket data
		const wsData = ws.deserializeAttachment() as WebsocketMetadata;

		// Run cleanup routine
		this.cleanup();

		// Call corresponding event handler
		if (wsData.isServer) {
			console.warn(`Relay "${this.state.code}": Server websocket error: ${error}`);
		} else {
			console.warn(`Relay "${this.state.code}": Client ${wsData.peerID} websocket error: ${error}`);
		}
	}

	// Handle messages from the server
	private onServerMessage(event: MessageEvent): void {
		// Deserialize the message
		const data = new Uint8Array(event.data as ArrayBuffer);
		if (data == undefined)
			return;

		var message = RelayMessage.deserialize(data, RelayMessage.Direction.SERVER_TO_RELAY);

		// Handle the message based on its type
		switch (message.type) {
			case RelayMessage.Type.DATA:
				this.forwardData(message as RelayMessage.ServerDataIn);
				break;

			case RelayMessage.Type.DISCONNECT:
				this.kickClient(message.id);
				break;

			case RelayMessage.Type.CONNECT:
				// Inform the client of the accepted connection
				const msg: RelayMessage.InformConnectClient = {
					direction: RelayMessage.Direction.RELAY_TO_CLIENT,
					type: RelayMessage.Type.CONNECT
				}
				const acceptMsg = message as RelayMessage.AcceptConnection;
				const peer = this.peers.get(acceptMsg.id);
				if (peer != undefined)
					this.getWebSocket(peer)?.send(RelayMessage.serialize(msg));
				else
					console.warn(`Relay "${this.code}": Cannot send accept to invalid peer ID "${acceptMsg.id}"`);
				break;

			case RelayMessage.Type.PING:
				break;

			default:
				console.warn(`Relay "${this.code}": Unexpected message type from server: ${(data as Uint8Array)[0]}`)
		}
	}

	// Handle server disconnection
	private onServerClose() {
		// Remove the server
		this.server = null;

		// Update database to mark the lobby as disconnected
		this.env.RELAY_D1.prepare("UPDATE lobbies SET connected = 0 WHERE code = ?").bind(this.state.code).run().catch((err) => {
			console.error(`Relay "${this.state.code}": Error updating lobby state in database: ${err.message}`);
		});
	}

	// Disconnect a client by ID
	private kickClient(ID: number): void {
		// Find the client WebSocket
		let ws = this.getPeerWebSocket(ID);
		if (ws === null) {
			console.warn(`Relay "${this.code}": Cannot kick client "${ID}" They do not exist.`);
			return;
		}

		// Close the WebSocket and remove from peers
		ws.close();
		this.peers.delete(ID);
		this.currentPeers &= ~(1 << ID);

		// Inform the server of the disconnection
		let msg: RelayMessage.InformDisconnect = {
			direction: RelayMessage.Direction.RELAY_TO_SERVER,
			type: RelayMessage.Type.DISCONNECT,
			id: ID
		};

		if (this.server !== null) {
			console.warn(`Relay "${this.code}": Cannot kick client "${ID}" No server connected.`);
			this.getWebSocket(this.server)?.send(RelayMessage.serialize(msg));
		}

		this.saveState();
	}

	// Handle client disconnection
	private async onClientClose(pid: number): Promise<void> {
		this.peers.delete(pid);

		if (this.server === null)
			return;

		const serverData: WebsocketMetadata = this.server.deserializeAttachment();

		// Create disconnect payload
		const payload: RelayMessagePayload.Disconnect<"relay-to-server"> = {
			msg: "dsc",
			pid: pid
		};

		// Create disconnect message
		const message: RelayMessage<typeof payload> = {
			pld: payload,
			dgs: await createMessageDigest(payload, this.env.HMAC_APPLICATION_SECRET, serverData.key)
		};

		// Send disconnect message
		this.server.send(JSON.stringify(message));
	}

	// Handle messages from a client
	private onClientMessage(ID: number, event: MessageEvent): void {
		// Deserialize the message
		const data = new Uint8Array(event.data as ArrayBuffer);
		if (data == undefined)
			return;

		var message = RelayMessage.deserialize(data, RelayMessage.Direction.CLIENT_TO_RELAY);

		// Handle the message based on its type
		switch (message.type) {
			case RelayMessage.Type.DATA:
				this.forwardData(message as RelayMessage.ClientData, ID);
				return;

			case RelayMessage.Type.PING:
				break;

			default:
				console.warn(`Relay "${this.code}": Unexpected message type from client: ${(data as Uint8Array)[0]}`);
				return;
		}
	}

	// Forward data between server and clients
	private forwardData(message: RelayMessage.ServerDataIn): void;
	private forwardData(message: RelayMessage.ClientData, source: number): void;
	private forwardData(message: RelayMessage.ClientData | RelayMessage.ServerDataIn, source?: number): void {
		// Forward based on message direction
		if (message.direction === RelayMessage.Direction.SERVER_TO_RELAY) {
			// Create a new message to send to clients
			const newMessage: RelayMessage.ClientData = {
				type: message.type,
				direction: RelayMessage.Direction.RELAY_TO_CLIENT,
				data: message.data
			}

			const serialMessage = RelayMessage.serialize(newMessage);

			// Send to all connected peers
			for (let i = 0; i < 32; i++) {
				// Check if the peer is connected
				const shouldSend: boolean =
					(this.currentPeers >>> i & 1) === 1 &&
					(message.destinations >>> i & 1) === 1;

				// Send the message if connected
				if (shouldSend) {
					const peer = this.getPeerWebSocket(i);
					if (peer != null)
						peer.send(serialMessage);
					else
						console.warn(`Relay "${this.code}": Cannot send data to invalid peer ID "${i}"`);
				}
			}
		} else if (message.direction === RelayMessage.Direction.CLIENT_TO_RELAY) {
			// Create a new message to send to the server
			const newMessage: RelayMessage.ServerDataOut = {
				type: message.type,
				direction: RelayMessage.Direction.RELAY_TO_SERVER,
				source: source as number,
				data: message.data
			}

			// Send to the server
			if (this.server !== null) {
				this.getWebSocket(this.server)?.send(RelayMessage.serialize(newMessage));
			}
		}
	}
}
