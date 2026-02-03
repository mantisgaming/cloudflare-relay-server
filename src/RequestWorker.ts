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

            let newRequest = new Request(request);
            newRequest.headers.set("Lobby-Code", lobbyCode);
            newRequest.headers.set("Method", "create");
            return await stub.fetch(newRequest);
        });

        router.get("/join/:id", withParams, async (req: IRequest) => {
            const lobbyCode = req.params.id;
            const stub = env.LOBBY_DO.getByName(lobbyCode) as DurableObjectStub<LobbyDO>;
            if (await stub.hasConnectedServer()) {
                let newRequest = new Request(request);
                newRequest.headers.set("Method", "join");
                return await stub.fetch(newRequest);
            } else {
                return new Response(`Lobby "${lobbyCode}" not found`, { status: 404 });
            }
        });

        router.all('*', () => {
            return new Response("Not Found", { status: 404 });
        });

        return router.fetch(request).catch((err) => {
            console.error(err.message);
            return new Response(err.message || "Internal Error", { status: err.status || 500 });
        });
    },
} satisfies ExportedHandler<Env>;