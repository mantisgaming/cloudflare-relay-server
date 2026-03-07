
/** Rate limiter bucket helpers */
export namespace Bucket {

    /** The state of a Bucket (serializable) */
    export interface BucketState {
        /** Current number of available tokens */
        tokens: number;
        /** Unix timestamp of the last time the token capacity was updated */
        lastUpdate: number;
    }

    /** Parameters for a Bucket */
    export interface BucketParameters {
        /** Maximum number of tokens stored */
        capacity: number;
        /** Token refill per minute */
        fillRate: number;
    }

    /** Bucket state and parameters combied */
    export interface BucketData{
        state: BucketState,
        params: BucketParameters
    };

    /** @returns The number of tokens the bucket currently contains */
    export function getTokenCount(bucket: BucketData, now?: number): number {
        const deltaTimeMinutes = ((now ?? Date.now()) - bucket.state.lastUpdate) / 1000 / 60;

        return Math.min(
            bucket.params.capacity,
            bucket.state.tokens + Math.floor(deltaTimeMinutes * bucket.params.fillRate)
        );
    }

    /** @returns `true` if the bucket contains at least one token, otherwise `false` */
    export function hasToken(bucket: BucketData, now?: number): boolean {

        // Reduce processing for buckets with tokens stored
        if (bucket.state.tokens > 0)
            return true;

        // Perform full processing for buckets that have been emptied
        return getTokenCount(bucket, now) > 0;
    }

    /** @returns The initial state of a bucket with the provided parameters */
    export function createDefaultState(params: BucketParameters, now?: number): BucketState {
        return {
            tokens: params.capacity,
            lastUpdate: now ?? Date.now(),
        };
    }

    /** 
     * Decrement the number of available tokens in
     * this bucket and return true if successful
     * 
     * @returns `true` if a token was successfully acquired, otherwise `false`
     */
    export function acquireToken(bucket: BucketData, now?: number): boolean {
        const tokenCount = getTokenCount(bucket);

        // If the bucket contains no tokens, return failure
        if (tokenCount <= 0)
            return false;

        // Update the state
        decrement(bucket, now);

        // Return success
        return true;
    }

    /** 
     * Decrement the number of available tokens regardless of validity
     */
    export function decrement(bucket: BucketData, now?: number): void {
        // Update the state
        normalize(bucket, now);
        bucket.state.tokens--;
    }

    /** Update the token count's actual value */
    export function normalize(bucket: BucketData, now?: number): void {
        // Nothing to do if the capacity is full
        if (bucket.state.tokens == bucket.params.capacity)
            return;

        bucket.state.lastUpdate = now ?? Date.now();
        bucket.state.tokens = getTokenCount(bucket, now);
    }
}