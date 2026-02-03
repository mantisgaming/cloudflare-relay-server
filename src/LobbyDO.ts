import { DurableObject } from "cloudflare:workers";

export class LobbyDO extends DurableObject<Env> {
    constructor(ctx: DurableObjectState<{}>, env: Env) {
        super(ctx, env);
    }

    async connectServer(request: Request): Promise<null> {
        const { 0: client, 1: server } = new WebSocketPair();
        return null;
    }

    async connectClient(request: Request): Promise<null> {
        const { 0: client, 1: server } = new WebSocketPair();
        return null;
    }

    async hasConnectedServer(): Promise<boolean> {
        return false;
    }
}
