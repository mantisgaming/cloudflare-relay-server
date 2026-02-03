import { DurableObject } from "cloudflare:workers";
import { RelayMessage } from "./RelayMessage";

export class LobbyDO extends DurableObject<Env> {
    private code: string;
    private server: WebSocket | null = null;
    private peers: Map<number, WebSocket> = new Map<number, WebSocket>();
	private nextPeer: number = 0;
	private currentPeers: number = 0;

    constructor(ctx: DurableObjectState<{}>, env: Env) {
        super(ctx, env);
        this.code = ctx.id.name as string;
    }

    async connectServer(request: Request): Promise<Response> {
        // Require that the request is a WebSocket upgrade
        const upgradeHeader = request.headers.get('Upgrade');
        if (!upgradeHeader || upgradeHeader !== "websocket") {
            return new Response("Expected WebSocket", { status: 426 });
        }

        if (this.server !== null) {
            return new Response("A server is already connected to this lobby", { status: 403 });
        }

        // Create a WebSocket pair
        const { 0: client, 1: server } = new WebSocketPair();
        server.accept();
        this.server = server;
        console.log(`Server connected to lobby "${this.code}"`);
        
        server.addEventListener("close", this.onServerClose.bind(this));
        server.addEventListener("message", this.onServerMessage.bind(this));
        server.addEventListener("error", this.onServerError.bind(this));

        this.server.send(RelayMessage.serialize({
            type: RelayMessage.Type.CODE,
            direction: RelayMessage.Direction.RELAY_TO_SERVER,
            code: this.code
        }));

        return new Response(null, { status: 101, webSocket: client });
    }

    async connectClient(request: Request): Promise<Response> {
        if (this.server === null) {
            return new Response("No server connected to this lobby", { status: 404 });
        }

        // Require that the request is a WebSocket upgrade
        const upgradeHeader = request.headers.get('Upgrade');
        if (!upgradeHeader || upgradeHeader !== "websocket") {
            return new Response("Expected WebSocket", { status: 426 });
        }

		const id = this.getNextAvailablePeer();

		if (id == -1) {
			return new Response("No available peer slots", { status: 403 });
		}
        
        // Create a WebSocket pair
        const { 0: client, 1: server } = new WebSocketPair();
		this.peers.set(id, server);
		this.currentPeers |= 1 << id;
        server.accept();
        console.log(`Client ${id} connected to lobby "${this.code}"`);

		server.addEventListener("close", this.onClientClose(id).bind(this));
		server.addEventListener("message", this.onClientMessage(id).bind(this));
		server.addEventListener("error", this.onClientError(id).bind(this));

		this.server.send(RelayMessage.serialize({
			direction: RelayMessage.Direction.RELAY_TO_SERVER,
			type: RelayMessage.Type.CONNECT,
			id: id
		}));

        return new Response(null, { status: 101, webSocket: client });
    }
    
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

    async hasConnectedServer(): Promise<boolean> {
        return this.server !== null;
    }

    private onServerClose(event: CloseEvent) {
        console.log(`Server disconnected from lobby ${this.code}`);
        this.server = null;
        this.currentPeers = 0;

        // Disconnect all connected peers
        this.peers.forEach((peer) => {
            peer.close();
        });
        this.peers.clear();
    }

	private onServerMessage(event: MessageEvent): void {
        const data = event.data;
		if (data == undefined)
			return;

		var message = RelayMessage.deserialize(data as Uint8Array, RelayMessage.Direction.SERVER_TO_RELAY);

		switch (message.type) {
			case RelayMessage.Type.DATA:
				this.forwardData(message as RelayMessage.ServerDataIn);
				break;

			case RelayMessage.Type.DISCONNECT:
				this.kickClient(message.id);
				break;

			case RelayMessage.Type.CONNECT:
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

	private kickClient(ID: number): void {
		let ws = this.peers.get(ID);

		if (ws == undefined) {
			console.warn(`Relay "${this.code}": Cannot kick client "${ID}" They do not exist.`);
			return;
		}

		ws.close();
		this.peers.delete(ID);
		this.currentPeers &= ~(1 << ID);

		let msg: RelayMessage.InformDisconnect = {
			direction: RelayMessage.Direction.RELAY_TO_SERVER,
			type: RelayMessage.Type.DISCONNECT,
			id: ID
		};

		this.server!.send(RelayMessage.serialize(msg))
	}

	private onServerError(error: ErrorEvent): void {
		console.warn(`Relay "${this.code}": Server web socket error: ${error.message}`);
	}
    
	private onClientClose(ID: number): (event: CloseEvent) => void {
		return (event: CloseEvent) => {
			console.log(`Relay "${this.code}": Client "${ID}" disconnected`);

			let msg: RelayMessage.InformDisconnect = {
				direction: RelayMessage.Direction.RELAY_TO_SERVER,
				type: RelayMessage.Type.DISCONNECT,
				id: ID
			};

			this.server!.send(RelayMessage.serialize(msg));

			this.peers.delete(ID);
			this.currentPeers &= ~(1 << ID);
		};
	}

	private onClientMessage(ID: number): (event: MessageEvent) => void {
		return (event: MessageEvent) => {
            const data = event.data;
			if (data == undefined)
				return;

			var message = RelayMessage.deserialize(data as Uint8Array, RelayMessage.Direction.CLIENT_TO_RELAY);

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

	private onClientError(ID: number): (error: ErrorEvent) => void {
		return (error: ErrorEvent) => {
			console.warn(`Relay "${this.code}": Client "${ID}" web socket error: ${error.message}`);
		}
	}

	private forwardData(message: RelayMessage.ServerDataIn): void;
	private forwardData(message: RelayMessage.ClientData, source: number): void;
	private forwardData(message: RelayMessage.ClientData | RelayMessage.ServerDataIn, source?: number): void {
		if (message.direction === RelayMessage.Direction.SERVER_TO_RELAY) {
			const newMessage: RelayMessage.ClientData = {
				type: message.type,
				direction: RelayMessage.Direction.RELAY_TO_CLIENT,
				data: message.data
			}

			const serialMessage = RelayMessage.serialize(newMessage);

			for (let i = 0; i < 32; i++) {
				const shouldSend: boolean = (this.currentPeers >>> i & 1) === 1;

				if (shouldSend) {
					const peer = this.peers.get(i);
					if (peer != undefined)
						peer.send(serialMessage);
					else
						console.warn(`Relay "${this.code}": Cannot send data to invalid peer ID "${i}"`);
				}
			}
		} else if (message.direction === RelayMessage.Direction.CLIENT_TO_RELAY) {
			const newMessage: RelayMessage.ServerDataOut = {
				type: message.type,
				direction: RelayMessage.Direction.RELAY_TO_SERVER,
				source: source as number,
				data: message.data
			}

			this.server!.send(RelayMessage.serialize(newMessage));
		}
	}
}
