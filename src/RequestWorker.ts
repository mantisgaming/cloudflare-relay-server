import { IRequest, IttyRouter, withParams } from "itty-router";
import { CodeGeneratorDO } from "./CodeGeneratorDO";
import { LobbyDO } from "./LobbyDO";
import { IPRateLimiterDO } from "./IPRateLimiterDO";
import { GlobalRateLimiterDO } from "./GlobalRateLimiterDO";

// Request worker for handling lobby creation and joining
export const RequestWorker: ExportedHandler<Env> = {
    // Handle incoming fetch requests
    async fetch(request, env, _ctx): Promise<Response> {
        // Set up the router
        const router = IttyRouter({
            base: env.BASE_ROUTE || "/relay"
        });

        // Find the shard corresponding to the IP address
        const IP = request.headers.get("CF-Connecting-IP") ?? "0.0.0.0";
        const IPHash = new Uint32Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(IP)))[0];
        const IPShardIndex = IPHash % env.IP_RATE_LIMITER_SHARDS;
        const ipRateLimiter = env.IP_RATE_LIMITER_DO.getByName(String(IPShardIndex)) as DurableObjectStub<IPRateLimiterDO>;

        // Clean the shard
        ipRateLimiter.clean();

        const globalRateLimiter = env.GLOBAL_RATE_LIMITER_DO.getByName("singleton") as DurableObjectStub<GlobalRateLimiterDO>;

        if (!await globalRateLimiter.acquireToken("any")) {
            return new Response("Request has been rate limited", { status: 429 });
        }

        if (!await ipRateLimiter.acquireToken(IP, "any")) {
            return new Response("Request has been rate limited", { status: 429 });
        }
        
        // Apply parameter middleware
        router.all('*', withParams);

        // Route for creating a new lobby
        router.get("/create", async (req: IRequest) => {
            try {
                // Ensure the request is a WebSocket upgrade
                if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
                    return new Response("Expected WebSocket Upgrade", { status: 400 });
                }

                if (!await globalRateLimiter.acquireToken("create")) {
                    return new Response("Request has been rate limited", { status: 429 });
                }

                if (!await ipRateLimiter.acquireToken(IP, "create")) {
                    return new Response("Request has been rate limited", { status: 429 });
                }

                // Generate a new lobby code
                const codeStub = env.CODE_GENERATOR_DO.getByName("singleton") as DurableObjectStub<CodeGeneratorDO>;
                const lobbyCode = await getNewLobbyCode(codeStub, env.RELAY_D1);

                // Get the Durable Object stub for the new lobby
                const stub = env.LOBBY_DO.getByName(lobbyCode) as DurableObjectStub<LobbyDO>;

                console.log(`Worker: Creating lobby with code "${lobbyCode}" on durable object id "${stub.id.toString()}"`);

                // Forward the request to create the lobby
                let newRequest = new Request(request);
                newRequest.headers.set("Lobby-Code", lobbyCode);
                newRequest.headers.set("Method", "create");

                // Return the response from the lobby Durable Object
                return await stub.fetch(newRequest);
            } catch (e) {
                const err = e instanceof Error ? e : new Error(String(e));
                console.error(`Worker: Error creating lobby: ${err.message}`);
                return new Response(err.message || "Internal Error", { status: 500 });
            }
        });

        // Route for joining an existing lobby
        router.get("/join/:id", withParams, async (req: IRequest) => {
            // Ensure the request is a WebSocket upgrade
            if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
                return new Response("Expected WebSocket Upgrade", { status: 400 });
            }

            if (!await globalRateLimiter.acquireToken("join")) {
                return new Response("Request has been rate limited", { status: 429 });
            }

            if (!await ipRateLimiter.acquireToken(IP, "join")) {
                return new Response("Request has been rate limited", { status: 429 });
            }

            // Get the lobby code from the URL parameters
            const lobbyCode = req.params.id.toUpperCase();
            const stub = env.LOBBY_DO.getByName(lobbyCode) as DurableObjectStub<LobbyDO>;

            // Check if the code is already in use in the database
            const existingLobby = await env.RELAY_D1.prepare("SELECT * FROM lobbies WHERE code = ? AND connected = 1").bind(lobbyCode).first();
            if (!existingLobby) {
                return new Response(`Lobby "${lobbyCode}" not found`, { status: 404 });
            }

            console.log(`Worker: Joining lobby with code "${lobbyCode}" on durable object id "${stub.id.toString()}"`);

            // Forward the request to join the lobby
            let newRequest = new Request(request);
            newRequest.headers.set("Method", "join");

            // Return the response from the lobby Durable Object
            return await stub.fetch(newRequest);
        });

        router.get("/reconnect/:id/:reconnectCode", withParams, async (req: IRequest) => {
            // Ensure the request is a WebSocket upgrade
            if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
                return new Response("Expected WebSocket Upgrade", { status: 400 });
            }

            if (!await globalRateLimiter.acquireToken("reconnect")) {
                return new Response("Request has been rate limited", { status: 429 });
            }

            if (!await ipRateLimiter.acquireToken(IP, "reconnect")) {
                return new Response("Request has been rate limited", { status: 429 });
            }

            // Get the lobby code and security code from the URL parameters
            const lobbyCode = req.params.id.toUpperCase();
            const reconnectCode = req.params.reconnectCode;

            // Get the Durable Object stub for the new lobby
            const stub = env.LOBBY_DO.getByName(lobbyCode) as DurableObjectStub<LobbyDO>;

            // Check if the code is already in use in the database
            const existingLobby = await env.RELAY_D1.prepare("SELECT * FROM lobbies WHERE code = ? AND connected = 0 AND reconnect_code = ?").bind(lobbyCode, reconnectCode).first();
            if (!existingLobby) {
                return new Response(`Lobby "${lobbyCode}" not found or already connected`, { status: 404 });
            }

            console.log(`Worker: Reconnecting lobby with code "${lobbyCode}" on durable object id "${stub.id.toString()}"`);

            // Forward the request to create the lobby
            let newRequest = new Request(request);
            newRequest.headers.set("Method", "reconnect");
            newRequest.headers.set("Reconnect-Code", reconnectCode)

            // Return the response from the lobby Durable Object
            return await stub.fetch(newRequest);
        });
        
        // Handle the request using the router
        const result = await router.fetch(request).catch((err) => {
            console.error(`Worker: Error handling request: ${err.message}`);
            return new Response(err.message || "Internal Error", { status: err.status || 500 });
        });

        // Fallback for unknown routes
        if (!result) {
            return new Response("Not Found", { status: 404 });
        }

        return result;
    },
    async scheduled(cont, env, ctx): Promise<void> {
        // Scheduler gets called every 5 seconds
        await cleanupLobbies(env).catch((err) => {
            console.error(`Worker: Error during scheduled cleanup: ${err.message}`);
        });

        await sendPingsInLobbies(env).catch((err) => {
            console.error(`Worker: Error during scheduled ping: ${err.message}`);
        });
    }
} satisfies ExportedHandler<Env>;

async function getNewLobbyCode(generator: DurableObjectStub<CodeGeneratorDO>, db: D1Database): Promise<string> {
    // Limit the number of attempts to avoid infinite loops
    for (let i = 0; i < 10; i++) {
        // Generate a new lobby code using the CodeGeneratorDO
        const code = await generator.generateCode();

        // Check if the code is already in use in the database
        const existingLobby = await db.prepare("SELECT * FROM lobbies WHERE code = ?").bind(code).first();
        if (existingLobby) {
            continue; // Code is already in use, try again
        }

        // Check if the code is banned
        const bannedCode = await db.prepare("SELECT * FROM banned_codes WHERE INSTR(?, code)").bind(code).first();
        if (bannedCode) {
            continue; // Code is banned, try again
        }

        return code; // Code is unique and not banned, return it
    }

    throw new Error("Failed to generate a unique lobby code after multiple attempts");
}

interface LobbyRecord {
    code: string;
}

async function cleanupLobbies(env: Env): Promise<void> {
    // Get old lobbies
    const { results: lobbies } = await env.RELAY_D1.prepare(`
        SELECT * FROM lobbies
        WHERE
            (last_updated < unixepoch() - 86400) OR 
            (last_updated < unixepoch() - 300 AND NOT connected)
    `).all() as { results: LobbyRecord[] };

    // Delete old lobbies from the database
    await env.RELAY_D1.prepare(`
        DELETE FROM lobbies
        WHERE
            (last_updated < unixepoch() - 86400) OR 
            (last_updated < unixepoch() - 300 AND NOT connected)
    `).run();

    var resetPromises: Promise<void>[] = [];

    // Cleanup the corresponding Durable Objects
    for (const lobby of lobbies) {
        const code = lobby.code;
        const stub = env.LOBBY_DO.getByName(code) as DurableObjectStub<LobbyDO>;
        resetPromises.push(stub.reset());
    }
    await Promise.all(resetPromises);
}

async function sendPingsInLobbies(env: Env): Promise<void> {
    // Get all lobbies from the database
    const { results: lobbies } = await env.RELAY_D1.prepare("SELECT *, unixepoch() FROM lobbies").all() as { results: LobbyRecord[] };

    // Send ping messages in all lobbies to check for active connections
    for (const lobby of lobbies) {
        const code = lobby.code;
        const stub = env.LOBBY_DO.getByName(code) as DurableObjectStub<LobbyDO>;
        stub.pingRoutine();
    }
}