
/**
 * RelayMessage.ts
 * Definitions for relay messages
 * used in communication between clients, relay, and server.
 */

/**
 * Relay message types  
 * `dat` - Data  
 * `con` - Connect  
 * `dsc` - Disconnect  
 * `inf` - Relay Info  
 * `unknown` - Placeholder for unexpected string
*/
export type RelayMessageType =
    "dat" |
    "con" |
    "dsc" |
    "inf" |
    "unknown";

/** Directions messages can be sent in */
export type RelayMessageDirection =
    "server-to-relay" |
    "relay-to-server" |
    "client-to-relay" |
    "relay-to-client";

/**
 * Utility for payload templates which removes
 * fields that are typed as `never`
 */
export type OmitUndefined<T> = {
    [K in keyof T as T[K] extends undefined ? never : K]: T[K]
}

/** Container namespace for relay message payload types */
export namespace RelayMessagePayload {
    /** Base information included with all relay messages */
    export interface Base<_T extends RelayMessageDirection> {
        /** Message type */
        msg: RelayMessageType;
    }

    /** Unknown relay message */
    export interface Unknown<T extends RelayMessageDirection> extends Base<T> {
        msg: "unknown";
    };

    /** Data relay message */
    export interface Data<T extends RelayMessageDirection> extends Base<T> {
        msg: "dat";
        /** Message data */
        dat: any;
        /** Destination peers */
        dst: T extends "server-to-relay" ? number[] : undefined;
        /** Source peer */
        src: T extends "relay-to-server" ? number : undefined;
    }

    /** Connect relay message */
    export interface Connect<T extends "relay-to-server" | "server-to-relay"> extends Base<T> {
        msg: "con";
        /** ID number of the relevant peer */
        pid: number;
    }

    /** Disconnect relay message */
    export interface Disconnect<T extends "relay-to-server" | "server-to-relay"> extends Base<T> {
        msg: "dsc";
        /** ID number of the relevant peer */
        pid: number;
    }

    /** Info relay message */
    export interface Info<T extends "relay-to-server" | "relay-to-client"> extends Base<T> {
        msg: "inf";
        /** HMAC session secret */
        key: string;
        /** Lobby code */
        code: T extends "relay-to-server" ? string : undefined;
        /** Key to reconnect to the same lobby code */
        reconnectKey: T extends "relay-to-server" ? string : undefined;
    }
}

/** Union of all message payload types */
export type RelayMessagePayload =
    RelayMessagePayload.Unknown<
        RelayMessageDirection
    > |
    RelayMessagePayload.Data<
        RelayMessageDirection
    > | 
    RelayMessagePayload.Connect<
        "server-to-relay" |
        "relay-to-server"
    > | 
    RelayMessagePayload.Disconnect<
        "server-to-relay" |
        "relay-to-server"
    > | 
    RelayMessagePayload.Info<
        "relay-to-client" |
        "relay-to-server"
    >;

/** The structure for all relay messages */
export type RelayMessage = {
    /** Relay message payload */
    pld: string;
    /** Relay message MAC digest for message validation */
    dgs: string;
};

export function createRandomKey(length: number): string {
    const buffer = new Uint8Array(length);
    crypto.getRandomValues(buffer);
    return toHexString(buffer);
}

export async function createMessageDigest(payload: string, ...keys: string[]): Promise<string> {
    const binaryKeys = keys.map(fromHexString);
    const payloadBytes = new TextEncoder().encode(payload);

    const data = new Uint8Array(payloadBytes.length + binaryKeys.reduce((size, key) => size + key.length, 0));

    data.set(payloadBytes, 0);
    binaryKeys.reduce((offset, key) => {
        data.set(key, offset);
        return offset + key.length;
    }, payloadBytes.length);

    const result = toHexString(new Uint8Array(await crypto.subtle.digest("SHA-256", data)));

    return result.substring(0, 8);
}

export async function verifyMessageDigest(message: RelayMessage, ...keys: string[]): Promise<boolean> {
    const calculatedDigest = await createMessageDigest(message.pld, ...keys);
    const receivedDigest = message.dgs;
    return calculatedDigest === receivedDigest;
}

function toHexString(data: Uint8Array): string {
    return data.reduce((str, byte) => str + byte.toString(16).padStart(2, '0'), '');
}

function fromHexString(hexString: string): Uint8Array {
    // Ensure the string has an even number of characters
    if (hexString.length % 2 !== 0) {
        throw new Error("Hex string must have an even number of characters");
    }

    const matches = hexString.match(/.{1,2}/g);

    if (matches === null) {
        throw new Error("Hex string failed to parse");
    }

    return new Uint8Array(matches.map((byte) => parseInt(byte, 16)));
};
