import { DurableObject } from "cloudflare:workers";
import { RelayMessage } from "./RelayMessage";

// Durable Object for relaying a WebSocket lobby between a server and multiple clients
export class LobbyDO extends DurableObject<Env> {
	// Lobby state
	private code: string | null = null;
	private server: string | null = null;
	private peers: Map<number, string> = new Map<number, string>();
	private nextPeer: number = 0;
	private currentPeers: number = 0;
	private lastUsedTime: Map<string, number> = new Map<string, number>();

	private websocketMap: Map<string, WebSocket> = new Map<string, WebSocket>();

	// Constructor
	constructor(ctx: DurableObjectState<{}>, env: Env) {
		super(ctx, env);
		this.loadState();

		ctx.getWebSockets().forEach((ws) => {
			const id = ws.deserializeAttachment() as string | undefined;
			if (id === undefined) {
				ws.close(1008, "Missing WebSocket attachment");
				return;
			}
			this.websocketMap.set(id, ws);
		});
	}

	// Persist the current state to storage
	private async saveState(): Promise<void> {
		await this.ctx.blockConcurrencyWhile(async () => {
			await this.ctx.storage.put("code", this.code);
			await this.ctx.storage.put("server", this.server);
			await this.ctx.storage.put("peers", JSON.stringify(Array.from(this.peers.entries())));
			await this.ctx.storage.put("nextPeer", this.nextPeer.toString());
			await this.ctx.storage.put("currentPeers", this.currentPeers.toString());
			await this.ctx.storage.put("lastUsedTimes", JSON.stringify(Array.from(this.lastUsedTime.entries())));
		});
	}

	private async loadState(): Promise<void> {
		await this.ctx.blockConcurrencyWhile(async () => {
			this.code = await this.ctx.storage.get("code") ?? this.code;
			this.server = await this.ctx.storage.get("server") ?? this.server;
			const peersData = await this.ctx.storage.get("peers");
			if (peersData !== undefined) {
				this.peers = new Map<number, string>(JSON.parse(peersData as string));
			}
			const nextPeerData = await this.ctx.storage.get("nextPeer");
			if (nextPeerData !== undefined) {
				this.nextPeer = parseInt(nextPeerData as string);
			}
			const currentPeersData = await this.ctx.storage.get("currentPeers");
			if (currentPeersData !== undefined) {
				this.currentPeers = parseInt(currentPeersData as string);
			}
			const lastUsedTimeData = await this.ctx.storage.get("lastUsedTimes");
			if (peersData !== undefined) {
				this.lastUsedTime = new Map<string, number>(JSON.parse(peersData as string));
			}
		});
	}

	private saveWebSocket(ws: WebSocket): string {
		const wsId = crypto.randomUUID();
		this.websocketMap.set(wsId, ws);
		ws.serializeAttachment(wsId);
		this.lastUsedTime.set(wsId, Date.now());
		return wsId;
	}

	private getWebSocket(id: string | null): WebSocket | null {
		if (id === null) {
			return null;
		}
		return this.websocketMap.get(id) ?? null;
	}

	private getPeerWebSocket(id: number): WebSocket | null {
		const wsId = this.peers.get(id) ?? null;
		return this.getWebSocket(wsId);
	}

	private getPeerFromWebSocket(wsID: string): number | null {
		for (const [id, storedWsID] of this.peers.entries()) {
			if (storedWsID === wsID) {
				return id;
			}
		}
		return null;
	}

	private isSocketServer(wsID: string): boolean {
		return this.server === wsID;
	}

	private cleanup(): void {
		this.websocketMap.forEach((socket, key) => {
			const wsID = socket.deserializeAttachment() as string;
			const lastResponse = this.lastUsedTime.get(wsID)!;

			if (Date.now() - lastResponse > 15000) {
				if (this.isSocketServer(key)) {
					this.onServerClose(new CloseEvent("Server timed out"));
				} else {
					this.onClientClose(this.getPeerFromWebSocket(key)!, new CloseEvent("Client timed out"));
				}
			}
		});
	}

	reset(): void {
		this.cleanup();

		this.server = null;
		this.peers = new Map<number, string>();
		this.nextPeer = 0;
		this.currentPeers = 0;
		this.lastUsedTime = new Map<string, number>();
		this.websocketMap = new Map<string, WebSocket>();

		this.saveState();
	}

	pingRoutine(): void {
		this.getWebSocket(this.server)?.send(RelayMessage.serialize({ type: RelayMessage.Type.PING, direction: RelayMessage.Direction.RELAY_TO_SERVER }));
		this.peers.forEach((peer) => {
			this.getWebSocket(peer)?.send(RelayMessage.serialize({ type: RelayMessage.Type.PING, direction: RelayMessage.Direction.RELAY_TO_CLIENT }));
		});

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
