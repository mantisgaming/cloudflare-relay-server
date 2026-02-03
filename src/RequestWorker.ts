import { IRequest, IttyRouter, withParams } from "itty-router";
import { CodeGeneratorDO } from "./CodeGeneratorDO";
import { LobbyDO } from "./LobbyDO";

export const RequestWorker = {
    async fetch(request, env, ctx): Promise<Response> {
        const router = IttyRouter();
        
        router.all('*', withParams);

        router.get("/create", async (req: IRequest) => {
            const codeStub = env.CODE_GENERATOR_DO.getByName("singleton") as DurableObjectStub<CodeGeneratorDO>;
            const lobbyCode = await codeStub.generateCode();
            const stub = env.LOBBY_DO.getByName(lobbyCode) as DurableObjectStub<LobbyDO>;
            return await stub.connectServer(request, lobbyCode);
        });

        router.get("/join/:id", withParams, async (req: IRequest) => {
            const lobbyCode = req.params.id;
            const stub = env.LOBBY_DO.getByName(lobbyCode) as DurableObjectStub<LobbyDO>;
            if (await stub.hasConnectedServer()) {
                return await stub.connectClient(request);
            } else {
                return new Response(`Lobby "${lobbyCode}" not found`, { status: 404 });
            }
        });

        router.all('*', () => {
            return new Response("Not Found", { status: 404 });
        });

        return router.fetch(request).catch((err) => {
            return new Response(err.message || "Internal Error", { status: err.status || 500 });
        });
    },
} satisfies ExportedHandler<Env>;