import { DurableObject } from "cloudflare:workers";
import { RelayMessage } from "./RelayMessage";

// Durable Object for relaying a WebSocket lobby between a server and multiple clients
export class LobbyDO extends DurableObject<Env> {
	// Lobby state
	private code: string | null = null;
	private server: WebSocket | null = null;
	private peers: Map<number, WebSocket> = new Map<number, WebSocket>();
	private nextPeer: number = 0;
	private currentPeers: number = 0;

	// Constructor
	constructor(ctx: DurableObjectState<{}>, env: Env) {
		super(ctx, env);
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
		server.accept();
		this.server = server;
		console.log(`Relay "${this.code}": Server connected to lobby`);

		// Set up event listeners
		server.addEventListener("close", this.onServerClose.bind(this));
		server.addEventListener("message", this.onServerMessage.bind(this));
		server.addEventListener("error", this.onServerError.bind(this));

		// Send the lobby code to the server
		this.server.send(RelayMessage.serialize({
			type: RelayMessage.Type.CODE,
			direction: RelayMessage.Direction.RELAY_TO_SERVER,
			code: this.code
		}));

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
		this.peers.set(id, server);
		this.currentPeers |= 1 << id;
		server.accept();
		console.log(`Relay "${this.code}": Client ${id} connected to lobby`);

		// Set up event listeners
		server.addEventListener("close", this.onClientClose(id).bind(this));
		server.addEventListener("message", this.onClientMessage(id).bind(this));
		server.addEventListener("error", this.onClientError(id).bind(this));

		// Inform the server of the new connection
		this.server.send(RelayMessage.serialize({
			direction: RelayMessage.Direction.RELAY_TO_SERVER,
			type: RelayMessage.Type.CONNECT,
			id: id
		}));

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

	// Check if a server is connected
	async hasConnectedServer(): Promise<boolean> {
		return this.server !== null;
	}

	// Handle server disconnection
	private onServerClose(event: CloseEvent) {
		console.log(`Relay "${this.code}": server disconnected`);
		this.server?.close();

		// Reset the lobby state
		this.server = null;
		this.currentPeers = 0;

		// Disconnect all connected peers
		this.peers.forEach((peer) => {
			peer.close();
		});
		this.peers.clear();
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
					peer.send(RelayMessage.serialize(msg));
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
		let ws = this.peers.get(ID);
		if (ws == undefined) {
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
			this.server.send(RelayMessage.serialize(msg));
		}

	}

	// Handle server WebSocket errors
	private onServerError(error: ErrorEvent): void {
		console.warn(`Relay "${this.code}": Server web socket error: ${error.message}`);
	}

	// Handle client disconnection
	private onClientClose(ID: number): (event: CloseEvent) => void {
		return (event: CloseEvent) => {
			console.log(`Relay "${this.code}": Client "${ID}" disconnected`);
			this.peers.get(ID)?.close();

			// Inform the server of the disconnection
			let msg: RelayMessage.InformDisconnect = {
				direction: RelayMessage.Direction.RELAY_TO_SERVER,
				type: RelayMessage.Type.DISCONNECT,
				id: ID
			};

			// Send the message to the server
			if (this.server !== null) {
				this.server.send(RelayMessage.serialize(msg));
			}

			// Remove the client from peers
			this.peers.delete(ID);
			this.currentPeers &= ~(1 << ID);
		};
	}

	// Handle messages from a client
	private onClientMessage(ID: number): (event: MessageEvent) => void {
		return (event: MessageEvent) => {
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
		};
	}

	// Handle client WebSocket errors
	private onClientError(ID: number): (error: ErrorEvent) => void {
		return (error: ErrorEvent) => {
			console.warn(`Relay "${this.code}": Client "${ID}" web socket error: ${error.message}`);
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
				const shouldSend: boolean = (this.currentPeers >>> i & 1) === 1;

				// Send the message if connected
				if (shouldSend) {
					const peer = this.peers.get(i);
					if (peer != undefined)
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
				this.server.send(RelayMessage.serialize(newMessage));
			}
		}
	}
}
