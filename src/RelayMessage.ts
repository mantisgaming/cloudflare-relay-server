
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
 * `ping` - Ping request  
 * `pong` - Ping response
*/
export type RelayMessageType =
    "dat" |
    "con" |
    "dsc" |
    "inf" |
    "ping" |
    "pong";

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
type OmitUndefined<T> = {
    [K in keyof T as T[K] extends undefined ? never : K]: T[K]
}

/** Container namespace for relay message payload types */
export namespace RelayMessagePayload {
    /** Base information included with all relay messages */
    export interface Base<_T extends RelayMessageDirection> {
        /** Message type */
        msg: RelayMessageType;
    }

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
    export interface Connect<T extends "relay-to-server" | "server-to-relay" | "relay-to-client"> extends Base<T> {
        msg: "con";
        /** ID number of the relevant peer */
        pid: T extends "relay-to-client" ? never : undefined;
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
    }

    /** Ping relay message*/
    export interface Ping<T extends RelayMessageDirection> extends Base<T> {
        msg: "ping";
        /** Ping send time */
        tim: any;
    }

    /** Ping relay message*/
    export interface Pong<T extends RelayMessageDirection> extends Base<T> {
        msg: "pong";
        /** Original ping send time */
        tim: any;
    }
}

/** Union of all message payload types */
export type RelayMessagePayload =
    RelayMessagePayload.Data<
        RelayMessageDirection
    > | 
    RelayMessagePayload.Connect<
        "server-to-relay" |
        "relay-to-client" |
        "relay-to-server"
    > | 
    RelayMessagePayload.Disconnect<
        "server-to-relay" |
        "relay-to-server"
    > | 
    RelayMessagePayload.Info<
        "relay-to-client" |
        "relay-to-server"
    > | 
    RelayMessagePayload.Ping<
        RelayMessageDirection
    > | 
    RelayMessagePayload.Pong<
        RelayMessageDirection
    >;

/** The structure for all relay messages */
export interface RelayMessage<T extends RelayMessagePayload.Base<D> = RelayMessagePayload, D extends RelayMessageDirection = RelayMessageDirection> {
    /** Relay message payload */
    pld: OmitUndefined<T>;
    /** Relay message HMAC hash for message validation */
    chk: string;
}
