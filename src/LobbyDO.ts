import { DurableObject } from "cloudflare:workers";
import { createMessageDigest, createRandomKey, OmitUndefined, RelayMessage, RelayMessagePayload, verifyMessageDigest } from "./RelayMessage";
import { Bucket } from "./Bucket";

interface LobbyState {
	code: string | null;
	nextPeer: number;
	lastCleanup: number;
	lastPing: number;
	requestBucket: Bucket.BucketState;
	joinBucket: Bucket.BucketState;
	connectBucket: Bucket.BucketState;
	reconnectBucket: Bucket.BucketState;
	serverMessageQueue: {
		pid: number,
		payload: OmitUndefined<RelayMessagePayload.Data<"client-to-relay">>
	}[];
	websocketData: {
		socketUID: string,
		data: WebsocketMetadata
	}[];
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
	private readonly state: LobbyState;

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
			lastPing: Date.now(),
			requestBucket: Bucket.createDefaultState(this.requestBucketParams),
			connectBucket: Bucket.createDefaultState(this.connectBucketParams),
			joinBucket: Bucket.createDefaultState(this.joinBucketParams),
			reconnectBucket: Bucket.createDefaultState(this.reconnectBucketParams),
			serverMessageQueue: [],
			websocketData: []
		}

		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));

		ctx.blockConcurrencyWhile((async () => {
			await this.loadState();
			await this.refreshSockets();
		}).bind(this));
	}

	private setState(state: Partial<LobbyState>): void {
		Object.assign(this.state, state);

		this.ctx.storage.put(
			Object.fromEntries(
				Object.entries(state).map(
					val => [
						val[0],
						JSON.stringify(val[1])
					]
				)
			)
		);
	}

	private saveStateValue<T extends keyof LobbyState>(...keys: T[]): void {
		this.ctx.storage.put(
			Object.fromEntries(
				Object.entries(this.state).filter(
					val => keys.find(
						key => key === val[0]
					) !== undefined
				).map(
					val => [
						val[0],
						JSON.stringify(val[1])
					]
				)
			)
		);
	}

	/** Load the state of the durable object */
	private async loadState(): Promise<void> {
		const loadedState = await this.ctx.storage.get(Object.keys(this.state));
		const entries: [string, any][] = []
		for (const entry of loadedState.entries()) {
			entries.push([
				entry[0],
				JSON.parse(entry[1] as string)
			])
		}
		Object.assign(this.state, Object.fromEntries(entries));
	}

	/** Remove any websockets that have not responded recently */
	private async cleanup(): Promise<void> {
		if (Date.now() - this.state.lastCleanup < 1000 * this.env.CLEANUP_INTERVAL)
			return;

		this.setState({
			lastCleanup: Date.now()
		});

		var activeSockets: Set<string> = new Set();

		for (const socket of this.ctx.getWebSockets()) {
			const socketID = socket.deserializeAttachment() as string;
			const wsData = this.state.websocketData.find(entry => entry.socketUID === socketID)?.data;
			activeSockets.add(socketID);

			if (wsData === undefined) {
				socket.close(1000, "Socket does not have metadata");
				continue;
			}

			const lastMessage = wsData.lastMessageTime;
			const lastActive = Math.max(
				wsData.lastActiveTime,
				this.ctx.getWebSocketAutoResponseTimestamp(socket)?.getTime() ?? 0
			);

			const now = Date.now();

			if (now - lastActive > 1000 * this.env.WEBSOCKET_TIMEOUT_DURATION) {
				socket.close(1000, "Connection Timed Out");
			} else if (now - lastMessage > 1000 * this.env.WEBSOCKET_IDLE_DURATION) {
				socket.close(1000, "Connection Idle");
			}
		}

		// Check if there are any missing websockets
		for (const entry of this.state.websocketData) {
			// Skip sockets that were found
			if (activeSockets.has(entry.socketUID)) {
				continue;
			}

			// remove the websocket data
			this.state.websocketData.splice(this.state.websocketData.findIndex(e => e === entry), 1);

			// if it is the server, handle it
			if (entry.data.isServer) {
				this.server = null;

				// log disconnect
				console.log(`Relay "${this.state.code}": Server websocket vanished`);
				continue;
			}

			// log disconnect
			console.log(`Relay "${this.state.code}": Client "${entry.data.peerID}" websocket vanished`);

			// If there is no server, nothing left to do
			if (this.server === null) {
				continue;
			}

			// Tell the server the client is disconnected
			const serverSocketID = this.server.deserializeAttachment() as string;
			const serverData = this.state.websocketData.find(entry => entry.socketUID === serverSocketID)!.data;

			// Create disconnect payload
			const payload: RelayMessagePayload.Disconnect<"relay-to-server"> = {
				msg: "dsc",
				pid: entry.data.peerID
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

		this.saveStateValue("websocketData");

		// Update the in-memory socket maps
		await this.refreshSockets();

		// If the lobby has been removed from the database, it should be reset
		const existingLobby = await this.env.RELAY_D1.prepare(
			"SELECT * FROM lobbies WHERE code = ?"
		).bind(this.state.code).first();

		if (!existingLobby) {
			this.reset();
		}
	}

	/**
	 * Reloads the in-memory websocket mapping
	 */
	private async refreshSockets(): Promise<void> {
		this.server = null;
		this.peers = new Map();

		for (const ws of this.ctx.getWebSockets()) {
			const socketID = ws.deserializeAttachment() as string;
			const wsData = this.state.websocketData.find(entry => entry.socketUID === socketID)!.data;
			if (wsData === undefined) {
				ws.close(1008, "Missing WebSocket attachment");
				return;
			}

			if (wsData.isServer) {
				if (this.server != null) {
					console.warn("Multiple websockets marked as server");
					ws.close(1008, "Socket appears to be duplicate server");
				} else {
					this.server = ws;
				}
			} else {
				this.peers.set(wsData.peerID, ws);
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
		this.ctx.storage.deleteAll();

		for (const socket of this.ctx.getWebSockets()) {
			socket.close(1012, "Lobby Reset");
		}
	}

	async pingRoutine(): Promise<void> {
		await this.cleanup();

		if (Date.now() - this.state.lastPing >= 1000 * this.env.PING_INTERVAL) {
			this.setState({
				lastPing: Date.now()
			});

			for (const socket of this.ctx.getWebSockets()) {
				if (socket.readyState === WebSocket.OPEN)
					socket.send("ping");
			}
		}
	}

	// Handle incoming requests
	async fetch(request: Request): Promise<Response> {
		// Rate limiter
		const pass = Bucket.acquireToken(this.RequestBucket);
		this.saveStateValue("requestBucket");

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
		this.saveStateValue("connectBucket");

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
		this.setState({
			code: code,
			nextPeer: 0
		});
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

		const newServerSocketID = crypto.randomUUID();
		server.serializeAttachment(newServerSocketID);
		this.state.websocketData.push({
			socketUID: newServerSocketID,
			data: serverWSData
		});
		this.saveStateValue("websocketData");

		// Send the lobby code to the server
		const infoPayload: RelayMessagePayload.Info<"relay-to-server"> = {
			code: code,
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
		this.saveStateValue("joinBucket");

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

		const newSocketID = crypto.randomUUID();
		server.serializeAttachment(newSocketID);
		this.state.websocketData.push({
			socketUID: newSocketID,
			data: peerWSData
		});
		this.saveStateValue("websocketData");

		console.log(`Relay "${this.state.code}": Client "${id}" connected to lobby`);

		const serverID = this.server.deserializeAttachment() as string;
		const serverWSData = this.state.websocketData.find(entry => entry.socketUID === serverID)!.data;

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
		this.saveStateValue("reconnectBucket");

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

		const newServerSocketID = crypto.randomUUID();
		server.serializeAttachment(newServerSocketID);
		this.state.websocketData.push({
			socketUID: newServerSocketID,
			data: serverWSData
		});
		this.saveStateValue("websocketData");

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
		for (const { pid, payload } of this.state.serverMessageQueue) {
			const packedMessage = await this.packDataPayload(pid, payload);
			if (packedMessage !== null) {
				queuedMessages.push(packedMessage);
			}
		}

		// Clear the server message queue since all messages will be sent to the server on reconnect
		this.setState({
			serverMessageQueue: []
		});

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
		this.saveStateValue("nextPeer");
		return peer;
	}

	/** Any websocket message will call this function */
	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		// Get the websocket data and update its last active time
		const socketID = ws.deserializeAttachment() as string;
		const wsData = this.state.websocketData.find(entry => entry.socketUID === socketID)!.data;
		wsData.lastActiveTime = Date.now();
		this.saveStateValue("websocketData");

		// Run cleanup routine
		await this.pingRoutine();

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

		wsData.lastMessageTime = Date.now();

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
		this.saveStateValue("websocketData");

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

	async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
		// Get the websocket data
		const socketID = ws.deserializeAttachment() as string;
		const wsData = this.state.websocketData.find(entry => entry.socketUID === socketID)!.data;

		// Run cleanup routine
		await this.pingRoutine();

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

	async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
		// Get the websocket data
		const socketID = ws.deserializeAttachment() as string;
		const wsData = this.state.websocketData.find(entry => entry.socketUID === socketID)!.data;

		// Run cleanup routine
		await this.pingRoutine();

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
				const socketID = clientWS.deserializeAttachment() as string;
				const clientWSData = this.state.websocketData.find(entry => entry.socketUID === socketID)!.data;

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

		const serverSocketID = this.server.deserializeAttachment() as string;
		const serverData = this.state.websocketData.find(entry => entry.socketUID === serverSocketID)!.data;

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

			const socketID = socket.deserializeAttachment() as string;
			const peerData = this.state.websocketData.find(entry => entry.socketUID === socketID)!.data;

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

			if (socket.readyState === WebSocket.OPEN)
				socket.send(JSON.stringify([message]));
		}
	}

	// Forward data from a client to the server
	private async forwardDataFromClient(pid: number, payload: RelayMessagePayload.Data<"client-to-relay">): Promise<void> {
		const packedMessage = await this.packDataPayload(pid, payload);

		// Queue message if the server is not connected
		if (packedMessage === null) {
			this.state.serverMessageQueue.push({ pid, payload });
			this.saveStateValue("serverMessageQueue");
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
		const serverSocketID = this.server.deserializeAttachment() as string;
		const serverData = this.state.websocketData.find(entry => entry.socketUID === serverSocketID)!.data;

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
