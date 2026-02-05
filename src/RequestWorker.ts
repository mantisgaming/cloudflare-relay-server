import { IRequest, IttyRouter, withParams } from "itty-router";
import { CodeGeneratorDO } from "./CodeGeneratorDO";
import { LobbyDO } from "./LobbyDO";

// Request worker for handling lobby creation and joining
export const RequestWorker = {
    // Handle incoming fetch requests
    async fetch(request, env, ctx): Promise<Response> {

        // Set up the router
        const router = IttyRouter();
        
        // Apply parameter middleware
        router.all('*', withParams);

        // Route for creating a new lobby
        router.get("/create", async (req: IRequest) => {
            // Ensure the request is a WebSocket upgrade
            if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
                return new Response("Expected WebSocket Upgrade", { status: 400 });
            }

            // Generate a new lobby code
            const codeStub = env.CODE_GENERATOR_DO.getByName("singleton") as DurableObjectStub<CodeGeneratorDO>;
            const lobbyCode = await codeStub.generateCode();

            // Get the Durable Object stub for the new lobby
            const stub = env.LOBBY_DO.getByName(lobbyCode) as DurableObjectStub<LobbyDO>;

            console.log(`Worker: Creating lobby with code "${lobbyCode}" on durable object id "${stub.id.toString()}"`);

            if (await stub.hasConnectedServer()) {
                return new Response(`Lobby code collision: "${lobbyCode}" already exists`, { status: 403 });
            }

            // Forward the request to create the lobby
            let newRequest = new Request(request);
            newRequest.headers.set("Lobby-Code", lobbyCode);
            newRequest.headers.set("Method", "create");

            // Return the response from the lobby Durable Object
            return await stub.fetch(newRequest);
        });

        // Route for joining an existing lobby
        router.get("/join/:id", withParams, async (req: IRequest) => {
            // Ensure the request is a WebSocket upgrade
            if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
                return new Response("Expected WebSocket Upgrade", { status: 400 });
            }
            
            // Get the lobby code from the URL parameters
            const lobbyCode = req.params.id;
            const stub = env.LOBBY_DO.getByName(lobbyCode) as DurableObjectStub<LobbyDO>;

            console.log(`Worker: Joining lobby with code "${lobbyCode}" on durable object id "${stub.id.toString()}"`);

            // Check if the lobby exists by seeing if a server is connected
            if (await stub.hasConnectedServer()) {
                // Forward the request to join the lobby
                let newRequest = new Request(request);
                newRequest.headers.set("Method", "join");

                // Return the response from the lobby Durable Object
                return await stub.fetch(newRequest);
            } else {
                // Lobby does not exist
                return new Response(`Lobby "${lobbyCode}" not found`, { status: 404 });
            }
        });

        // Fallback for unknown routes
        router.all('*', () => {
            return new Response("Not Found", { status: 404 });
        });

        // Handle the request using the router
        return router.fetch(request).catch((err) => {
            console.error(`Worker: Error handling request: ${err.message}`);
            return new Response(err.message || "Internal Error", { status: err.status || 500 });
        });
    },
} satisfies ExportedHandler<Env>;