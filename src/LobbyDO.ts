import { DurableObject } from "cloudflare:workers";
import { createMessageDigest, createRandomKey, OmitUndefined, RelayMessage, RelayMessagePayload, verifyMessageDigest } from "./RelayMessage";
import { Bucket } from "./Bucket";

interface LobbyState {
	code: string | null;
	nextPeer: number;
	lastCleanup: number;
	requestBucket: Bucket.BucketState;
	joinBucket: Bucket.BucketState;
	connectBucket: Bucket.BucketState;
	reconnectBucket: Bucket.BucketState;
	serverMessageQueue: [number, OmitUndefined<RelayMessagePayload.Data<"client-to-relay">>][];
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
	/** Message rate limiter bucket */
	bucket: Bucket.BucketState
} & (
		{
			isServer: true;
		} | {
			isServer: false,
			/** Peer ID number for this websocket */
			peerID: number
		}
	);

// Durable Object for relaying a WebSocket lobby between a server and multiple clients
export class LobbyDO extends DurableObject<Env> {
	private state: LobbyState;

	private server: WebSocket | null = null;
	private peers: Map<number, WebSocket> = new Map();

	private readonly serverBucketParams: Bucket.BucketParameters;
	private readonly peerBucketParams: Bucket.BucketParameters;
	private readonly requestBucketParams: Bucket.BucketParameters;
	private readonly joinBucketParams: Bucket.BucketParameters;
	private readonly connectBucketParams: Bucket.BucketParameters;
	private readonly reconnectBucketParams: Bucket.BucketParameters;

	private get RequestBucket(): Bucket.BucketData {
		return {
			params: this.requestBucketParams,
			state: this.state.requestBucket
		};
	}

	private get JoinBucket(): Bucket.BucketData {
		return {
			params: this.joinBucketParams,
			state: this.state.joinBucket
		};
	}

	private get ConnectBucket(): Bucket.BucketData {
		return {
			params: this.connectBucketParams,
			state: this.state.connectBucket
		};
	}

	private get ReconnectBucket(): Bucket.BucketData {
		return {
			params: this.reconnectBucketParams,
			state: this.state.reconnectBucket
		};
	}

	// Constructor
	constructor(ctx: DurableObjectState<{}>, env: Env) {
		super(ctx, env);

		this.serverBucketParams = {
			capacity: env.RATE_LIMITER_SERVER_MESSAGE_CAPACITY,
			fillRate: env.RATE_LIMITER_SERVER_MESSAGE_RATE
		}

		this.peerBucketParams = {
			capacity: env.RATE_LIMITER_CLIENT_MESSAGE_CAPACITY,
			fillRate: env.RATE_LIMITER_CLIENT_MESSAGE_RATE
		}

		this.requestBucketParams = {
			capacity: env.RATE_LIMITER_LOBBY_REQUEST_CAPACITY,
			fillRate: env.RATE_LIMITER_LOBBY_REQUEST_RATE
		}

		this.joinBucketParams = {
			capacity: env.RATE_LIMITER_LOBBY_JOIN_CAPACITY,
			fillRate: env.RATE_LIMITER_LOBBY_JOIN_RATE
		}

		this.connectBucketParams = {
			capacity: env.RATE_LIMITER_LOBBY_CONNECT_CAPACITY,
			fillRate: env.RATE_LIMITER_LOBBY_CONNECT_RATE
		}

		this.reconnectBucketParams = {
			capacity: env.RATE_LIMITER_LOBBY_RECONNECT_CAPACITY,
			fillRate: env.RATE_LIMITER_LOBBY_RECONNECT_RATE
		}

		this.state = {
			code: null,
			nextPeer: 0,
			lastCleanup: Date.now(),
			requestBucket: Bucket.createDefaultState(this.requestBucketParams),
			connectBucket: Bucket.createDefaultState(this.connectBucketParams),
			joinBucket: Bucket.createDefaultState(this.joinBucketParams),
			reconnectBucket: Bucket.createDefaultState(this.reconnectBucketParams),
			serverMessageQueue: []
		}

		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));

		ctx.blockConcurrencyWhile((async () => {
			await this.loadState.bind(this)();
			await this.refreshSockets.bind(this)();
		}).bind(this));
	}

	/** Save the state of the durable object */
	private saveState(): void {
		this.ctx.storage.put("state", this.state)
	}

	/** Load the state of the durable object */
	private async loadState(): Promise<void> {
		const loadedState = await this.ctx.storage.get("state") as LobbyState
		this.state = {
			...this.state,
			...loadedState
		};
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

		await this.refreshSockets();

		// If the lobby has been removed from the database, it should be reset
		const existingLobby = await this.env.RELAY_D1.prepare("SELECT * FROM lobbies WHERE code = ?").bind(this.state.code).first();
		if (!existingLobby) {
			this.reset();
		}
	}

	private async refreshSockets(): Promise<void> {
		this.server = null;
		this.peers = new Map();

		for (const ws of this.ctx.getWebSockets()) {
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
		
		if (this.state.code === null)
			return;

		const connectedInt = this.server === null ? 0 : 1;

		// Update database with lobby connection state
		const result = await this.env.RELAY_D1.prepare(`
			UPDATE lobbies
			SET connected = ?
			WHERE code = ? AND connected != ?
		`).bind(connectedInt, this.state.code, connectedInt).run();

		if (!result.success) {
			console.error("Database Error (updating lobby connection state):", result.error);
		}
	}

	/** Reset the durable object */
	reset(): void {
		this.server = null;
		this.peers = new Map();
		this.state = {
			code: this.state.code,
			nextPeer: 0,
			lastCleanup: Date.now(),
			requestBucket: Bucket.createDefaultState(this.requestBucketParams),
			connectBucket: Bucket.createDefaultState(this.connectBucketParams),
			joinBucket: Bucket.createDefaultState(this.joinBucketParams),
			reconnectBucket: Bucket.createDefaultState(this.reconnectBucketParams),
			serverMessageQueue: []
		}

		for (const socket of this.ctx.getWebSockets()) {
			socket.close(1012, "Lobby Reset");
		}

		this.saveState();
	}

	async pingRoutine(): Promise<void> {
		for (const socket of this.ctx.getWebSockets()) {
			socket.send("ping");
		}

		this.cleanup();
	}

	// Handle incoming requests
	async fetch(request: Request): Promise<Response> {
		// Rate limiter
		const pass = Bucket.acquireToken(this.RequestBucket);
		this.saveState();

		if (!pass) {
			return new Response("Rate Limited", { status: 429 });
		}

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
		// Rate limiter
		const pass = Bucket.acquireToken(this.ConnectBucket);
		this.saveState();

		if (!pass) {
			return new Response("Rate Limited", { status: 429 });
		}

		// Require that the request is a WebSocket upgrade
		const upgradeHeader = request.headers.get('Upgrade');
		if (!upgradeHeader || upgradeHeader !== "websocket") {
			return new Response("Expected WebSocket", { status: 426 });
		}

		// Check if a server is already connected
		if (this.server !== null) {
			return new Response("A server is already connected to this lobby", { status: 403 });
		}

		// Save the code and peer index in state
		this.state.code = code;
		this.state.nextPeer = 0;
		this.saveState();
		const randomCode = createRandomKey(2);

		// Insert the new lobby code into the database
		const insertResult = await this.env.RELAY_D1.prepare("INSERT INTO lobbies (code, reconnect_code) VALUES (?, ?)").bind(this.state.code, randomCode).run();
		if (!insertResult.success) {
			return new Response("Database Error (creating lobby)", { status: 500 });
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
			lastMessageTime: Date.now(),
			bucket: Bucket.createDefaultState(this.serverBucketParams)
		};
		server.serializeAttachment(serverWSData);

		// Send the lobby code to the server
		const infoPayload: RelayMessagePayload.Info<"relay-to-server"> = {
			code: this.state.code,
			key: serverWSData.key,
			reconnectKey: randomCode,
			msg: "inf"
		};

		const stringPayload = JSON.stringify(infoPayload);

		// Create packet
		const infoPacket: RelayMessage = {
			dgs: await createMessageDigest(stringPayload, this.env.HMAC_APPLICATION_SECRET, serverWSData.key),
			pld: stringPayload
		};

		// Send info to server
		server.send(JSON.stringify([infoPacket]));

		// Log success
		console.log(`Relay "${this.state.code}": Server connected to lobby`);

		// Return the client WebSocket
		return new Response(null, { status: 101, webSocket: client });
	}

	async connectClient(request: Request): Promise<Response> {
		// Rate limiter
		const pass = Bucket.acquireToken(this.JoinBucket);
		this.saveState();

		if (!pass) {
			return new Response("Rate Limited", { status: 429 });
		}

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
		const peerWSData: WebsocketMetadata = {
			isServer: false,
			peerID: id,
			key: createRandomKey(32),
			lastActiveTime: Date.now(),
			lastMessageTime: Date.now(),
			bucket: Bucket.createDefaultState(this.peerBucketParams)
		};
		server.serializeAttachment(peerWSData);

		console.log(`Relay "${this.state.code}": Client "${id}" connected to lobby`);

		const serverWSData: WebsocketMetadata = this.server.deserializeAttachment();

		// Inform the server of the new connection
		const connectPayload: RelayMessagePayload.Connect<"relay-to-server"> = {
			msg: "con",
			pid: id
		};

		const stringPayload = JSON.stringify(connectPayload);

		// Create packet
		const connectPacket: RelayMessage = {
			dgs: await createMessageDigest(stringPayload, this.env.HMAC_APPLICATION_SECRET, serverWSData.key),
			pld: stringPayload
		};

		// Send info to server
		this.server.send(JSON.stringify([connectPacket]));

		// Return the client WebSocket
		return new Response(null, { status: 101, webSocket: client });
	}

	async reconnectServer(request: Request): Promise<Response> {
		// Rate limiter
		const pass = Bucket.acquireToken(this.ReconnectBucket);
		this.saveState();

		if (!pass) {
			return new Response("Rate Limited", { status: 429 });
		}

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

		const randomCode = createRandomKey(2);

		// Update database to mark the lobby as connected
		const updateResult = await this.env.RELAY_D1.prepare("UPDATE lobbies SET connected = 1, reconnect_code = ? WHERE code = ?").bind(randomCode, this.state.code).run();
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
			lastMessageTime: Date.now(),
			bucket: Bucket.createDefaultState(this.serverBucketParams)
		};
		server.serializeAttachment(serverWSData);

		// Send the lobby code to the server
		const infoPayload: RelayMessagePayload.Info<"relay-to-server"> = {
			code: this.state.code,
			key: serverWSData.key,
			reconnectKey: randomCode,
			msg: "inf"
		};

		const stringPayload = JSON.stringify(infoPayload);

		// Create Packet
		const infoPacket: RelayMessage = {
			dgs: await createMessageDigest(stringPayload, this.env.HMAC_APPLICATION_SECRET, serverWSData.key),
			pld: stringPayload
		};

		const connectionPackets: RelayMessage[] = [];

		for (const [pid] of this.peers.entries()) {
			// Inform the server of the new connection
			const connectPayload: RelayMessagePayload.Connect<"relay-to-server"> = {
				msg: "con",
				pid: pid
			};

			const stringPayload = JSON.stringify(connectPayload);

			// Create packet
			const connectPacket: RelayMessage = {
				dgs: await createMessageDigest(stringPayload, this.env.HMAC_APPLICATION_SECRET, serverWSData.key),
				pld: stringPayload
			};

			// Add to list of packets
			connectionPackets.push(connectPacket);
		}

		const queuedMessages: RelayMessage[] = [];

		// Add any queued messages to the list of packets to send
		for (const [pid, payload] of this.state.serverMessageQueue) {
			const packedMessage = await this.packDataPayload(pid, payload);
			if (packedMessage !== null) {
				queuedMessages.push(packedMessage);
			}
		}

		// Clear the server message queue since all messages will be sent to the server on reconnect
		this.state.serverMessageQueue = [];
		this.saveState();

		// Send info to server
		server.send(JSON.stringify([infoPacket, ...connectionPackets, ...queuedMessages]));

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
	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
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

		// Reject messages that are too big
		if (new TextEncoder().encode(message).length >= this.env.MAXIMUM_MESSAGE_SIZE * 1024) {
			ws.close(1009, `Message Over ${this.env.MAXIMUM_MESSAGE_SIZE}KB`);
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

		// Check rate limiter
		const pass = Bucket.acquireToken(
			{
				state: wsData.bucket,
				params: wsData.isServer ?
					this.serverBucketParams :
					this.peerBucketParams
			},
			wsData.lastActiveTime
		);

		// Save rate limiter state
		ws.serializeAttachment(wsData);

		// If rate limiter fails send failure response
		if (!pass) {
			console.warn(`Relay "${this.state.code}": Rate limit exceeded for websocket`);
			ws.send("rate_limited");
			return;
		}

		// Parse data
		var data: any;
		
		try {
		data = JSON.parse(message) as any;
		} catch (e) {
			ws.close(1007, "Malformed JSON");
			return;
		}

		// Validate that the message is an array of packets
		if (!Array.isArray(data)) {
			ws.close(1007, "Expected message to be an array of packets");
			return;
		}

		// Ignore empty messages
		if (data.length === 0) {
			return;
		}

		const messageDataArray = data as any[];

		for (const messageData of messageDataArray) {
			// Validate message format
			if (messageData.pld === undefined || messageData.dgs === undefined) {
				ws.close(1007, "Malformed message packet");
				return;
			}

			// Check hmac
			if (!await verifyMessageDigest(messageData, this.env.HMAC_APPLICATION_SECRET, wsData.key)) {
				ws.close(1007, "HMAC Digest Did Not Match");
				return;
			}

			// Call corresponding event handler
			if (wsData.isServer) {
				await this.onServerMessage(messageData);
			} else {
				await this.onClientMessage(wsData.peerID, messageData);
			}
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
			console.log(`Relay "${this.state.code}": Server websocket closed${reason ? ": " + reason : ""}`);
			this.onServerClose();
		} else {
			console.log(`Relay "${this.state.code}": Client ${wsData.peerID} websocket closed${reason ? ": " + reason : ""}`);
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
	private async onServerMessage(message: RelayMessage): Promise<void> {
		const payload: RelayMessagePayload = JSON.parse(message.pld);

		// Handle the message based on its type
		switch (payload.msg) {
			case "dat":
				await this.forwardDataFromServer(payload);
				break;

			case "dsc":
				this.kickClient(payload.pid);
				break;

			case "con":
				// Inform the client of the accepted connection
				const clientID = payload.pid;
				const clientWS = this.peers.get(clientID);

				// Check that the client exists
				if (clientWS === undefined) {
					console.warn(`Relay "${this.state.code}": Server accepted invalid client ID`);
					return;
				}

				// Get client socket info
				const clientWSData = clientWS.deserializeAttachment() as WebsocketMetadata;

				// Create the payload
				const infoPayload: OmitUndefined<RelayMessagePayload.Info<"relay-to-client">> = {
					msg: "inf",
					key: clientWSData.key
				};

				const stringPayload = JSON.stringify(infoPayload);

				// Create Packet
				const infoPacket: RelayMessage = {
					dgs: await createMessageDigest(stringPayload, this.env.HMAC_APPLICATION_SECRET, clientWSData.key),
					pld: stringPayload
				};

				// Send Packet
				clientWS.send(JSON.stringify([infoPacket]));
				break;

			default:
				console.warn(`Relay "${this.state.code}": Unexpected message type from server: ${payload.msg}`)
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
	private kickClient(pid: number): void {
		const peer = this.peers.get(pid);

		// Do nothing if there is no client with the pid
		if (peer === undefined) {
			console.warn(`Relay "${this.state.code}": Cannot kick client "${pid}" They do not exist.`);
			return;
		}

		// Close the WebSocket and remove from peers
		peer.close(1000, "Kicked From Server");
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

		const stringPayload = JSON.stringify(payload);

		// Create disconnect message
		const message: RelayMessage = {
			dgs: await createMessageDigest(stringPayload, this.env.HMAC_APPLICATION_SECRET, serverData.key),
			pld: stringPayload
		};

		// Send disconnect message
		this.server.send(JSON.stringify([message]));
	}

	// Handle messages from a client
	private onClientMessage(pid: number, message: RelayMessage): void {
		const payload: RelayMessagePayload = JSON.parse(message.pld);

		// Handle the message based on its type
		switch (payload.msg) {
			case "dat":
				this.forwardDataFromClient(pid, payload);
				break;

			default:
				console.warn(`Relay "${this.state.code}": Unexpected message type from client: ${pid}`);
				return;
		}
	}

	// Forward data from a server to one or more clients
	private async forwardDataFromServer(payload: RelayMessagePayload.Data<"server-to-relay">): Promise<void> {
		for (const [pid, socket] of this.peers) {
			// Only send messages to intended peers
			if (!payload.dst.includes(pid))
				continue;

			const peerData = socket.deserializeAttachment() as WebsocketMetadata;

			// Create data payload
			const newPayload: OmitUndefined<RelayMessagePayload.Data<"relay-to-client">> = {
				msg: "dat",
				dat: payload.dat
			};

			const stringPayload = JSON.stringify(newPayload);

			const message: RelayMessage = {
				dgs: await createMessageDigest(stringPayload, this.env.HMAC_APPLICATION_SECRET, peerData.key),
				pld: stringPayload
			}

			socket.send(JSON.stringify([message]));
		}
	}

	// Forward data from a client to the server
	private async forwardDataFromClient(pid: number, payload: RelayMessagePayload.Data<"client-to-relay">): Promise<void> {
		const packedMessage = await this.packDataPayload(pid, payload);

		// Queue message if the server is not connected
		if (packedMessage === null) {
			this.state.serverMessageQueue.push([pid, payload]);
			this.saveState();
			return;
		}

		// Send data message
		this.server!.send(JSON.stringify([packedMessage]));
	}

	private async packDataPayload(pid: number, payload: OmitUndefined<RelayMessagePayload.Data<"client-to-relay">>): Promise<RelayMessage | null> {
		// Ignore messages if the server is not connected
		if (this.server === null) {
			return null;
		}

		// Get server data
		const serverData = this.server.deserializeAttachment() as WebsocketMetadata;

		// Create data payload
		const newPayload: OmitUndefined<RelayMessagePayload.Data<"relay-to-server">> = {
			msg: "dat",
			src: pid,
			dat: payload.dat
		};

		const stringPayload = JSON.stringify(newPayload);

		// Create data message
		const message: RelayMessage = {
			pld: stringPayload,
			dgs: await createMessageDigest(stringPayload, this.env.HMAC_APPLICATION_SECRET, serverData.key)
		};

		return message;
	}
}
