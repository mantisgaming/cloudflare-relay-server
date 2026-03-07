import { DurableObject } from "cloudflare:workers";
import { Bucket } from "./Bucket";

type BucketMap = Map<string, Bucket.BucketData>;
type BucketParamMap = [string, Bucket.BucketParameters][];

// Durable Object for generating unique lobby codes
export class IPRateLimiterDO extends DurableObject<Env> {
    private readonly bucketMap: BucketMap;
    private readonly bucketParamMap: BucketParamMap;
    private readonly defaultBucketParams: Bucket.BucketParameters = {
        capacity: 20,
        fillRate: 60
    };

    private lastClean: number = Date.now();

    // constructor
    constructor(ctx: DurableObjectState<{}>, env: Env) {
        super(ctx, env);
        this.bucketMap = new Map();
        this.bucketParamMap = [
            ["any", {
                capacity: 20,
                fillRate: 120
            }],
            ["create", {
                capacity: 20,
                fillRate: 30
            }],
            ["reconnect", {
                capacity: 20,
                fillRate: 30
            }],
            ["join", {
                capacity: 30,
                fillRate: 60
            }],
        ];
    }

    /** Acquire permission to make a request */
    public acquireToken(IPAddress: string, requestType: string): boolean {
        const bucketKeys: [string, string][] = [
            [IPAddress, "any"],
            [IPAddress, requestType],
        ];

        const buckets = bucketKeys.map<Bucket.BucketData>(this.getBucket.bind(this));

        const now = Date.now();

        for (let i = 0; i < buckets.length; i++) {
            const bucket = buckets[i];

            if (!Bucket.hasToken(bucket, now))
                return false;
        }

        for (let i = 0; i < buckets.length; i++) {
            Bucket.decrement(buckets[i], now);
        }

        return true;
    }

    private getBucket(key: [string, string]): Bucket.BucketData {
        const mapKey = `${key[0]}:${key[1]}`;

        // return an existing bucket
        if (this.bucketMap.has(mapKey))
            return this.bucketMap.get(mapKey)!;

        // initialize a new bucket
        const params = this.getParamsForRequest(key[1]);
        const newBucket: Bucket.BucketData = {
            params,
            state: Bucket.createDefaultState(params)
        }

        // insert and return the new bucket
        this.bucketMap.set(mapKey, newBucket)
        return newBucket;
    }

    private getParamsForRequest(request: string): Bucket.BucketParameters {
        for (let i = 0; i < this.bucketParamMap.length; i++) {
            const [match, params] = this.bucketParamMap[i];

            if (match == request)
                return params;
        }

        console.warn(`Unexpected request type: ${request}`);
        return this.defaultBucketParams;
    }

    public clean(): void {
        const now = Date.now();

        // Wait at least 5 seconds between cleans
        if (now - this.lastClean < 5000)
            return;

        this.lastClean = now;

        // For each bucket
        for (const [key, val] of this.bucketMap) {
            const deltaTime = now - val.state.lastUpdate;

            // If the bucket is not full
            if (val.state.tokens != val.params.capacity) {
                // Update it if it has been over a minute since the bucket was used
                if (deltaTime > 1000 * 60) {
                    Bucket.normalize(val, now);
                }

                continue;
            }

            // If it has been over 5 minutes that the bucket has been filled, delete it
            if (deltaTime > 1000 * 60 * 5 && val.state.tokens == val.params.capacity) {
                this.bucketMap.delete(key);

                continue;
            }
        }
    }
}
