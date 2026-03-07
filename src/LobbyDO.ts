import { DurableObject } from "cloudflare:workers";

interface LobbyState {
	code: string | null;
	nextPeer: number;
}

type WebsocketMetadata = {
	key: string;
	lastMessageTime: number;
	lastActiveTime: number;
	isServer: true;
} | {
	key: string;
	lastMessageTime: number;
	lastActiveTime: number;
	isServer: false,
	peerID: number
};

// Durable Object for relaying a WebSocket lobby between a server and multiple clients
export class LobbyDO extends DurableObject<Env> {
	private state: LobbyState = {
		code: null,
		nextPeer: 0
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
	}

	private saveState(): void {
		this.ctx.storage.put(this.state as Record<string, any>)
	}

	private async loadState(): Promise<void> {
		Object.assign(this.state, await this.ctx.storage.get(Object.keys(this.state)));
	}

	private cleanup(): void {
		for (const socket of this.ctx.getWebSockets()) {
			const socketData = socket.deserializeAttachment() as WebsocketMetadata;
			const lastAction = socketData.lastActiveTime;
			const lastMessage = Math.max(
				socketData.lastMessageTime,
				this.ctx.getWebSocketAutoResponseTimestamp(socket)?.getTime() ?? 0
			);

			const now = Date.now();

			if (now - lastMessage > 1000 * 15) {
				if (socketData.isServer) {
					this.onServerClose(socket, new CloseEvent("Server timed out"));
				} else {
					this.onClientClose(socket, new CloseEvent("Client timed out"));
				}
			} else if (now - lastAction > 1000 * 60 * 30) {
				if (socketData.isServer) {
					this.onServerClose(socket, new CloseEvent("Server was idle"));
				} else {
					this.onClientClose(socket, new CloseEvent("Client was idle"));
				}
			}
		}
	}

	reset(): void {
		this.server = null;
		this.peers = new Map();
		this.state = {
			code: null,
			nextPeer: 0
		}

		for (const socket of this.ctx.getWebSockets()) {
			socket.close(1012, "Lobby has been reset");
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
		// Require that the request is a WebSocket upgrade
		const upgradeHeader = request.headers.get('Upgrade');
		if (!upgradeHeader || upgradeHeader !== "websocket") {
			return new Response("Expected WebSocket", { status: 426 });
		}

		// Check if a server is already connected
		if (this.server !== null) {
			return new Response("A server is already connected to this lobby", { status: 403 });
		}

		// Create a WebSocket pair
		this.code = code;
		const { 0: client, 1: server } = new WebSocketPair();

		// Accept the server WebSocket
		this.ctx.acceptWebSocket(server);
		this.server = this.saveWebSocket(server);
		console.log(`Relay "${this.code}": Server connected to lobby`);

		// Send the lobby code to the server
		this.getWebSocket(this.server)?.send(RelayMessage.serialize({
			type: RelayMessage.Type.CODE,
			direction: RelayMessage.Direction.RELAY_TO_SERVER,
			code: this.code
		}));

		this.saveState();

		// Insert the new lobby code into the database
		const insertResult = await this.env.RELAY_D1.prepare("INSERT INTO lobbies (code) VALUES (?)").bind(this.code).run();
		if (insertResult.error) {
			return new Response("Database Error", { status: 500 });
		}

		// Return the client WebSocket
		return new Response(null, { status: 101, webSocket: client });
	}

	async connectClient(request: Request): Promise<Response> {
		// Check if a server is connected
		if (this.server === null) {
			return new Response("No server connected to this lobby", { status: 404 });
		}

		// Require that the request is a WebSocket upgrade
		const upgradeHeader = request.headers.get('Upgrade');
		if (!upgradeHeader || upgradeHeader !== "websocket") {
			return new Response("Expected WebSocket", { status: 426 });
		}

		// Get the next available peer ID
		const id = this.getNextAvailablePeer();

		// No available slots
		if (id == -1) {
			return new Response("No available peer slots", { status: 403 });
		}

		// Create a WebSocket pair
		const { 0: client, 1: server } = new WebSocketPair();

		// Accept the client WebSocket
		this.ctx.acceptWebSocket(server);
		this.peers.set(id, this.saveWebSocket(server));
		this.currentPeers |= 1 << id;
		console.log(`Relay "${this.code}": Client "${id}" connected to lobby`);

		// Inform the server of the new connection
		this.getWebSocket(this.server)?.send(RelayMessage.serialize({
			direction: RelayMessage.Direction.RELAY_TO_SERVER,
			type: RelayMessage.Type.CONNECT,
			id: id
		}));

		this.saveState();

		// Return the client WebSocket
		return new Response(null, { status: 101, webSocket: client });
	}

	async reconnectServer(request: Request): Promise<Response> {
		// Require that the request is a WebSocket upgrade
		const upgradeHeader = request.headers.get('Upgrade');
		if (!upgradeHeader || upgradeHeader !== "websocket") {
			return new Response("Expected WebSocket", { status: 426 });
		}

		// Check if a server is already connected
		if (this.server !== null) {
			return new Response("A server is already connected to this lobby", { status: 403 });
		}

		// Check database for existing lobby
		const existingLobby = await this.env.RELAY_D1.prepare("SELECT * FROM lobbies WHERE code = ?").bind(this.code).first();
		if (!existingLobby) {
			return new Response(`Lobby "${this.code}" not found`, { status: 404 });
		}

		// Create a WebSocket pair
		const { 0: client, 1: server } = new WebSocketPair();

		// Accept the server WebSocket
		this.ctx.acceptWebSocket(server);
		this.server = this.saveWebSocket(server);
		console.log(`Relay "${this.code}": Server connected to lobby`);

		// Send the lobby code to the server
		this.getWebSocket(this.server)?.send(RelayMessage.serialize({
			type: RelayMessage.Type.CODE,
			direction: RelayMessage.Direction.RELAY_TO_SERVER,
			code: this.code!
		}));

		this.saveState();

		// Update database to mark the lobby as connected
		const updateResult = await this.env.RELAY_D1.prepare("UPDATE lobbies SET connected = 1 WHERE code = ?").bind(this.code).run();
		if (updateResult.error) {
			return new Response("Database Error", { status: 500 });
		}

		// Return the client WebSocket
		return new Response(null, { status: 101, webSocket: client });
	}

	// Find the next available peer ID (0-31)
	private getNextAvailablePeer(): number {
		for (let i = 0; i < 32; i++) {
			let id = (this.nextPeer + i) % 32;
			if ((this.currentPeers >>> id & 0x1) === 0) {
				this.nextPeer = (id + 1) % 32;
				return id;
			}
		}

		return -1;
	}

	webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
		const wsID = ws.deserializeAttachment() as string;
		this.lastUsedTime.set(wsID, Date.now());

		this.cleanup();
		if (this.isSocketServer(wsID)) {
			this.onServerMessage(new MessageEvent("message", { data: message }));
		} else {
			const peerID = this.getPeerFromWebSocket(wsID);
			if (peerID !== null) {
				this.onClientMessage(peerID, new MessageEvent("message", { data: message }));
			} else {
				console.warn(`Relay "${this.code}": Received message from unknown WebSocket`);
				console.log(`Known websockets: ${JSON.stringify(this.websocketMap)}`)
				ws.close();
			}
		}
	}

	webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): void {
		const wsID = ws.deserializeAttachment() as string;
		this.lastUsedTime.delete(wsID);

		this.cleanup();
		if (this.isSocketServer(wsID)) {
			this.onServerClose(new CloseEvent("close", { code, reason, wasClean }));
		} else {
			const peerID = this.getPeerFromWebSocket(wsID);
			if (peerID !== null) {
				this.onClientClose(peerID, new CloseEvent("close", { code, reason, wasClean }));
			} else {
				console.warn(`Relay "${this.code}": Received close event from unknown WebSocket`);
				ws.close();
			}
		}

		this.saveState();
	}

	webSocketError(ws: WebSocket, error: unknown): void {
		this.cleanup();
		const wsID = ws.deserializeAttachment() as string;
		if (this.isSocketServer(wsID)) {
			this.onServerError(new ErrorEvent("error", { error }));
		} else {
			const peerID = this.getPeerFromWebSocket(wsID);
			if (peerID !== null) {
				this.onClientError(peerID, new ErrorEvent("error", { error }));
			} else {
				console.warn(`Relay "${this.code}": Received error from unknown WebSocket`);
			}
		}
	}

	// Handle server disconnection
	private onServerClose(event: CloseEvent) {
		console.log(`Relay "${this.code}": server disconnected`);
		this.getWebSocket(this.server)?.close();

		// Remove the server
		this.server = null;

		// Update database to mark the lobby as disconnected
		this.env.RELAY_D1.prepare("UPDATE lobbies SET connected = 0 WHERE code = ?").bind(this.code).run().catch((err) => {
			console.error(`Relay "${this.code}": Error updating lobby state in database: ${err.message}`);
		});

		this.saveState();
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

	// Handle server WebSocket errors
	private onServerError(error: ErrorEvent): void {
		console.warn(`Relay "${this.code}": Server web socket error: ${error.message}`);
	}

	// Handle client disconnection
	private onClientClose(ID: number, event: CloseEvent): void {
		console.log(`Relay "${this.code}": Client "${ID}" disconnected`);
		this.getPeerWebSocket(ID)?.close();

		// Inform the server of the disconnection
		let msg: RelayMessage.InformDisconnect = {
			direction: RelayMessage.Direction.RELAY_TO_SERVER,
			type: RelayMessage.Type.DISCONNECT,
			id: ID
		};

		// Send the message to the server
		if (this.server !== null) {
			this.getWebSocket(this.server)?.send(RelayMessage.serialize(msg));
		}

		// Remove the client from peers
		this.peers.delete(ID);
		this.currentPeers &= ~(1 << ID);
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

	// Handle client WebSocket errors
	private onClientError(ID: number, error: ErrorEvent): void {
		console.warn(`Relay "${this.code}": Client "${ID}" web socket error: ${error.message}`);
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
