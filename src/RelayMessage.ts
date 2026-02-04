
// RelayMessage.ts
// Definitions and serialization/deserialization for relay messages
// used in communication between clients, relay, and server.
export namespace RelayMessage {
    // Enumeration of message types
    export enum Type {
        UNDEFINED = -1,
        DATA,
        CONNECT,
        DISCONNECT,
        CODE,
        
        MAXIMUM
    }

    // Enumeration of message directions
    export enum Direction {
        SERVER_TO_RELAY,
        RELAY_TO_SERVER,
        CLIENT_TO_RELAY,
        RELAY_TO_CLIENT
    }

    // Type aliases for different message structures
    export type RELAY_TO_ANY =
        Direction.RELAY_TO_CLIENT |
        Direction.RELAY_TO_SERVER;

    export type ANY_TO_RELAY =
        Direction.CLIENT_TO_RELAY |
        Direction.SERVER_TO_RELAY;

    export type SERVER_DIRECTION =
        Direction.SERVER_TO_RELAY |
        Direction.RELAY_TO_SERVER;

    export type CLIENT_DIRECTION =
        Direction.CLIENT_TO_RELAY |
        Direction.RELAY_TO_CLIENT;

    // Message type definitions
    export type Undefined = {
        type: Type.UNDEFINED,
        direction: Direction
    }

    export type SendCode = {
        type: Type.CODE,
        direction: Direction.RELAY_TO_SERVER,
        code: string
    }

    export type InformConnectServer = {
        type: Type.CONNECT,
        direction: Direction.RELAY_TO_SERVER,
        id: number
    }

    export type AcceptConnection = {
        type: Type.CONNECT,
        direction: Direction.SERVER_TO_RELAY,
        id: number
    }

    export type InformConnectClient = {
        type: Type.CONNECT,
        direction: Direction.RELAY_TO_CLIENT
    }

    export type ServerDataIn = {
        type: Type.DATA,
        direction: Direction.SERVER_TO_RELAY,
        destinations: number,
        data: Uint8Array
    }

    export type ServerDataOut = {
        type: Type.DATA,
        direction: Direction.RELAY_TO_SERVER,
        source: number,
        data: Uint8Array
    }

    export type ClientData = {
        type: Type.DATA,
        direction: CLIENT_DIRECTION,
        data: Uint8Array
    }

    export type KickClient = {
        type: Type.DISCONNECT,
        direction: Direction.SERVER_TO_RELAY,
        id: number
    }

    export type InformDisconnect = {
        type: Type.DISCONNECT,
        direction: RELAY_TO_ANY,
        id: number
    }

    // Deserialize a message from Uint8Array
    export function deserialize(data: Uint8Array, direction: Direction): RelayMessage {
        // Initialize an undefined message
        var undef: Undefined = {
            direction: direction,
            type: Type.UNDEFINED
        }

        // Check for empty data
        if (data.length == 0)
            return undef;

        // Determine the message type
        var messageType: Type = Type.UNDEFINED;
        if (data[0] as number < Type.MAXIMUM.valueOf())
            messageType = data[0] as Type;
        
        // Parse the message based on its type and direction
        switch(messageType) {
            case Type.DATA:
                switch (direction) {
                    case Direction.RELAY_TO_CLIENT:
                    case Direction.CLIENT_TO_RELAY:
                        return {
                            type: messageType,
                            direction: direction,
                            data: data.subarray(1)
                        };
                    case Direction.SERVER_TO_RELAY:
                        return {
                            type: messageType,
                            direction: direction,
                            destinations: parseS32(data.subarray(1,5)),
                            data: data.subarray(5)
                        }
                    case Direction.RELAY_TO_SERVER:
                        return {
                            type: messageType,
                            direction: direction,
                            source: data[1] as number,
                            data: data.subarray(2)
                        }
                }
            case Type.CONNECT:
                switch (direction) {
                    case Direction.CLIENT_TO_RELAY:
                        return undef;
                    case Direction.RELAY_TO_CLIENT:
                        return {
                            type: messageType,
                            direction: direction
                        };
                    case Direction.SERVER_TO_RELAY:
                    case Direction.RELAY_TO_SERVER:
                        return {
                            type: messageType,
                            direction: direction,
                            id: data[1] as number
                        };
                }

            case Type.DISCONNECT:
                switch (direction) {
                    case Direction.CLIENT_TO_RELAY:
                    case Direction.RELAY_TO_CLIENT:
                        return undef;
                    case Direction.SERVER_TO_RELAY:
                    case Direction.RELAY_TO_SERVER:
                        return {
                            type: messageType,
                            direction: direction,
                            id: data[1] as number
                        };
                }

            case Type.CODE:
                if (direction == Direction.RELAY_TO_SERVER)
                    return {
                        type: messageType,
                        direction: direction,
                        code: new TextDecoder().decode(data.subarray(1))
                    };

                return undef;
        }

        return {
            direction: direction as ANY_TO_RELAY,
            type: Type.UNDEFINED
        };
    }

    // Serialize a message to Uint8Array
    export function serialize(data: RelayMessage): Uint8Array {
        // Initialize result array
        var result: number[] = [];

        // Refuse to serialize undefined messages
        if (data.type == Type.UNDEFINED)
            throw Error("Refusal to serialize undefined message");

        // Push the message type
        result.push(data.type.valueOf());

        // Serialize based on message type
        switch (data.type) {
            case Type.DATA:
                switch (data.direction) {
                    case Direction.CLIENT_TO_RELAY:
                    case Direction.RELAY_TO_CLIENT:
                        break;
                    case Direction.RELAY_TO_SERVER:
                        result.push(data.source);
                        break;
                    case Direction.SERVER_TO_RELAY:
                        result.push(...encodeS32(data.destinations))
                        break;
                }
                result.push(...data.data);
                break;

            case Type.CONNECT:
                if (data.direction == Direction.RELAY_TO_SERVER || data.direction == Direction.SERVER_TO_RELAY)
                    result.push(data.id);
                break;

            case Type.DISCONNECT:
                result.push(data.id);
                break;

            case Type.CODE:
                result.push(...new TextEncoder().encode(data.code))
                break;
        }

        return new Uint8Array(result);
    }

    // Helper functions to parse and encode 32-bit integers
    function parseS32(data: Uint8Array): number {
        if (data.length < 4)
            throw Error("Cannot parse int 32 from less than 4 bytes");

        var n1 = data[0] as number;
        var n2 = data[1] as number;
        var n3 = data[2] as number;
        var n4 = data[3] as number;

        return (
            (n1 << 0) |
            (n2 << 8) |
            (n3 << 16) |
            (n4 << 24)
        );
    }

    // Encode a 32-bit integer into Uint8Array
    function encodeS32(data: number): Uint8Array {
        var result: Uint8Array = new Uint8Array(4);

        result[0] = data >> 0 & 0xff;
        result[1] = data >> 8 & 0xff;
        result[2] = data >> 16 & 0xff;
        result[3] = data >> 24 & 0xff;

        return result;
    }
}

// Define the RelayMessage type as a union of all message types
export type RelayMessage =
    RelayMessage.Undefined |
    RelayMessage.SendCode |
    RelayMessage.InformConnectServer |
    RelayMessage.InformConnectClient |
    RelayMessage.AcceptConnection |
    RelayMessage.ServerDataIn |
    RelayMessage.ServerDataOut |
    RelayMessage.ClientData |
    RelayMessage.KickClient |
    RelayMessage.InformDisconnect;